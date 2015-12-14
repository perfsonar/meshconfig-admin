'use strict';

//node
var dns = require('dns');
var net = require('net');

//contrib
var winston = require('winston');
var async = require('async');
var request = require('request');
//var Promise = require('promise');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models');
var common = require('../common');

/* works, but this isn't the bottleneck
var ip_cache = {};
function resolveip_cached(ip, cb) {
    if(ip_cache[ip]) return cb(null, ip_cache[ip]);
    dns.reverse(ip, function(err, hostnames) {
        if(err) return cb(err);
        ip_cache[ip] = hostnames; 
        cb(null, hostnames);
    });
}
*/

function cache_host(service, res, cb) {
    //construct host information url
    var uri = res.request.uri;
    
    //truncate the last 2 path (/lookup/record) which is already part of service-host
    var pathname_tokens = uri.pathname.split("/");
    pathname_tokens.splice(-3);
    var pathname = pathname_tokens.join("/");


    //reconstruct the url for the host record
    //if(service['service-host'] === undefined) console.dir(service);
    var url = uri.protocol+"//"+uri.host+pathname+'/'+service['service-host'][0];
    //logger.debug("caching host:"+service['service-host'][0]);
    logger.debug("caching host:"+url);
    request({url: url, timeout: 1000*10, json: true}, function(err, res, host) {
        if(err) return cb(err);
        if(res.statusCode != 200) return cb(new Error("failed to cache host from:"+url+" statusCode:"+res.statusCode));
        /* sample host
        {
            host-net-tcp-autotunemaxbuffer-send: [
            "33554432 bytes"
            ],
            pshost-bundle: [
            "perfsonar-toolkit"
            ],
            state: "renewed",
            type: [
            "host"
            ],
            client-uuid: [
            "62af464a-1bab-4e0a-afd6-00026dc1a3db"
            ],
            location-longitude: [
            "-97.4405"
            ],
            host-net-tcp-autotunemaxbuffer-recv: [
            "33554432 bytes"
            ],
            group-communities: [
            "USATLAS",
            "LHCTier2",
            "ESnet",
            "Internet2",
            "OSG",
            "LHC",
            "WLCG"
            ],
            expires: "2015-11-09T02:59:50.236Z",
            host-name: [
            "129.15.40.232"
            ],
            host-os-version: [
            "6.7 (Final)"
            ],
            host-hardware-cpuid: [
            "Intel(R) Pentium(R) CPU G6950 @ 2.80GHz"
            ],
            host-os-name: [
            "CentOS"
            ],
            location-city: [
            "Norman"
            ],
            pshost-bundle-version: [
            "3.5"
            ],
            host-net-tcp-congestionalgorithm: [
            "htcp"
            ],
            host-os-kernel: [
            "Linux 2.6.32-573.7.1.el6.web100.x86_64"
            ],
            location-sitename: [
            "University of Oklahoma"
            ],
            host-hardware-memory: [
            "3755 MB"
            ],
            host-net-tcp-maxbuffer-send: [
            "67108864 bytes"
            ],
            uri: "lookup/host/3fc31895-d6fa-43e2-a6e7-ea745d88a621",
            pshost-toolkitversion: [
            "3.5"
            ],
            host-net-tcp-maxbuffer-recv: [
            "67108864 bytes"
            ],
            location-latitude: [
            "35.1835"
            ],
            host-hardware-processorcount: [
            "1"
            ],
            host-hardware-processorcore: [
            "2"
            ],
            host-administrators: [
            "lookup/person/f27e8de8-0f2f-4996-b068-e9617db13e10"
            ],
            location-country: [
            "US"
            ],
            host-hardware-processorspeed: [
            "2793.027 MHz"
            ],
            location-state: [
            "OK"
            ],
            location-code: [
            "73019"
            ],
            host-net-interfaces: [
            "lookup/interface/2dc4f65c-c001-4956-959f-2222bd1e59b7",
            "lookup/interface/b60a3a72-b7b2-4c84-aba7-a243ab5deff1",
            "lookup/interface/ced7f410-cde1-43b0-a904-93c856bb3f03"
            ],
            ttl: [ ]
        }
        */
    
        var rec = {
            uuid: host['client-uuid'][0],
            sitename: host['location-sitename'][0],
            /*
            info: {
                //note.. host is from the sls/host - not toolkit json
                hardware_processorcount: host['host-hardware-processorcount']?host['host-hardware-processorcount'][0]:null,
                hardware_processorspeed: host['host-hardware-processorspeed']?host['host-hardware-processorspeed'][0]:null,
                hardware_memory: host['host-hardware-memory']?host['host-hardware-memory'][0]:null,
                toolkitversion: host['pshost-toolkitversion']?host['pshost-toolkitversion'][0]:null,
                os_version: host['host-os-version']?host['host-os-version'][0]:null,
            },
            */
            info: get_hostinfo(host),
            location: get_location(host),
            communities: host['group-communities']||[],

            //TODO - I need to query the real admin records from the cache (gocdb2sls service already genenrates contact records)
            //I just have to store them in our table
            admins: host['host-administrators'],
            count: 0, //number of times updated (exists to allow updateTime update)
        };
        console.dir(rec.info);

        var address = host['host-name'][0]; //could be ip or hostname
       
        //resolve ip
        //logger.debug("resolving "+address);
        if(net.isIP(address)) {
            rec.ip = address;
            dns.reverse(address, function(err, hostnames) {
                if(err) {
                    logger.error("couldn't reverse lookup ip: "+address);
                    logger.error(err);  //continue
                } else {
                    if(hostnames.length > 0) rec.hostname = hostnames[0]; //only using the first entry?
                }
                upsert_host();
            }); 
        } else {
            rec.hostname = address;
            dns.lookup(address, function(err, address, family) {
                if(err) {
                    logger.error("couldn't lookup "+address);
                } else rec.ip = address;
                upsert_host();
            });
        }

        function upsert_host() {
            //logger.info(rec.uuid);
            db.Host.findOne({where: {uuid: rec.uuid}}).then(function(_host) {
               if(_host) {
                    //console.dir(JSON.stringify(_host));
                    rec.count = _host.count+1; //force records to get updatedAt updated
                    _host.update(rec).then(function() {
                        //TODO - check error?
                        cb();
                    });
                } else {
                    logger.info("registering new host for the first time:"+rec.uuid);
                    db.Host.create(rec).then(function() {
                        //TODO - check error?
                        cb();
                    });
                }
            });
        }

    });
}

function get_location(service) {
    return {
        longitude: (service['location-longitude']?service['location-longitude'][0]:null),
        latitude: (service['location-latitude']?service['location-latitude'][0]:null), 
        city: (service['location-city']?service['location-city'][0]:null),
        state: (service['location-state']?service['location-state'][0]:null),
        postal_code: (service['location-code']?service['location-code'][0]:null),
        country: (service['location-country']?service['location-country'][0]:null),
    };
}

function get_hostinfo(host) {

    var info = {};
    for(var key in host) {
        var v = host[key];

        if(key == "host-administrators") continue;
        if(key == "host-net-interfaces") continue;
        if(key == "host-name") continue;
        
        ["host-", "pshost-"].forEach(function(prefix) {
            var p = key.indexOf(prefix);
            if(p === 0) {
                var ikey = key.substr(prefix.length);
                ikey = ikey.replace(/-/g, '_');
                info[ikey] = v[0];
            }
        });
    }
    return info;
}

//TODO no point of existing.. just merge with docache_ls
function cache_ls(ls, lsid, cb) {
    logger.debug("caching ls:"+lsid+" from "+ls.url);
    request({url: ls.url, timeout: 1000*10, json: true}, function(err, res, services) {
        if(err) return cb(err);
        if(res.statusCode != 200) return cb(new Error("failed to cahce service from:"+ls.url+" statusCode:"+res.statusCode));
        var count_new = 0;
        var count_update = 0;
        var host_uuids = []; //list of all host_uuids cached for this round
        async.eachSeries(services, function(service, next) {
            //TODO apply exclusion

            //ignore record with no client-uuid (probably old toolkit instance?)
            if(service['client-uuid'] === undefined) {
                logger.error("client-uuid not set - skipping");
                logger.error(service);
                return next();//continue to next service
            }
            var uuid = service['client-uuid'][0]; 
            logger.debug("caching service:"+service['service-locator'][0]);

            var rec = {
                client_uuid: uuid,
                uuid: uuid+'.'+service['service-type'][0],
                name: service['service-name'][0],
                type: service['service-type'][0],
                locator: service['service-locator'][0], //locator is now a critical information needed to generate the config
                lsid: lsid, //make it easier for ui

                sitename: service['location-sitename'][0],
                location: get_location(service),
                
                //TODO - I need to query the real admin records from the cache (gocdb2sls service already genenrates contact records)
                //I just have to store them in our table
                admins: service['service-administrators'],

                count: 0, //number of times updated (exists to allow updateTime update)
            };
            db.Service.findOne({where: {uuid: rec.uuid}}).then(function(_service) {
                if(_service) {
                    //update updatedAt time
                    count_update++;
                    rec.count = _service.count+1; //force records to get updated
                    _service.update(rec).then(maybe_cache_host);
                } else {
                    count_new++;
                    db.Service.create(rec).then(maybe_cache_host);
                }
            });

            function maybe_cache_host() {
                if(~host_uuids.indexOf(uuid)) return next(); //skip if we already cached this host
                cache_host(service, res, function(err) {
                    if(err) logger.error(err); //continue
                    host_uuids.push(uuid);
                    next();
                });
            }

        }, function(err) {
            logger.info("loaded "+services.length+" services for "+ls.label+" from "+ls.url + " updated:"+count_update+" new:"+count_new);
            cb();
        });
    })
}

function cache_global_ls(service, id, cb) {
    //load activehosts.json
    request(service.activehosts_url, {timeout: 1000*5}, function(err, res, body) {
        if(err) return cb(err);
        if(res.statusCode != 200) return cb(new Error("failed to download activehosts.json from:"+service.activehosts_url+" statusCode:"+res.statusCode));
        try {
            var activehosts = JSON.parse(body);
            //load from all activehosts
            async.each(activehosts.hosts, function(host, next) {
                if(host.status != "alive") {
                    logger.warn("skipping "+host.locator+" with status:"+host.status);
                    return next();
                }
                //massage the service url so that I can use cache_ls to do the rest
                service.url = host.locator+service.query;
                cache_ls(service, id, next);
            }, cb); 
        } catch (e) {
            //couldn't parse activehosts json..
            return cb(e);
        }
    }); 
}

function update_dynamic_hostgroup(cb) {
    logger.debug("update_dynamic_hostgruop TODO");
    db.Hostgroup.findAll({where: {type: 'dynamic'}}).then(function(groups) {
        async.forEach(groups, function(group, next) {
            common.filter.resolveHostGroup(group.host_filter, group.service_type, function(err, hosts) {
                if(err) return next(err);
                group.hosts = hosts.recs;
                group.save().then(function() {
                    logger.debug(group.host_filter);
                    logger.debug("... resolved to ...");
                    logger.debug(hosts);
                    next();
                });
            });
        }, function(err) {
            if(err) logger.error(err);
            if(cb) cb();
        });
    });
}

exports.start = function(cb) {
    logger.info("starting slscache");
    async.forEachOf(config.datasource.services, function(service, id, next) {

        function run_cache_ls(_next) {
            cache_ls(service, id, function(err) {
                if(err) logger.error(err);
                update_dynamic_hostgroup(_next);
            }); 
        }

        function run_cache_global_ls(_next) {
            cache_global_ls(service, id, function(err) {
                if(err) logger.error(err);
                update_dynamic_hostgroup(_next);
            }); 
        }

        var timeout = service.cache || 60*30*1000; //default to 30 minutes
        switch(service.type) {
        case "sls":
            setInterval(run_cache_ls, timeout);
            run_cache_ls(next);
            break;
        case "global-sls":
            setInterval(run_cache_global_ls, timeout);
            run_cache_global_ls(next);
            break;
        default:
            logger.error("unknown datasource/service type:"+service.type);
        }

    }, /*function(err) {
        if(err) logger.error(err);

        function run_cache_profile(cb) {
            common.profile.cache(cb||function(err) {
                if(err) logger.error(err);
            });
        };
        logger.info("starting profile cache");
        setInterval(run_cache_profile, 1000*300); //5 minutes?
        run_cache_profile(cb);
    }*/ cb);
}


