'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const async = require('async');
const moment = require('moment');
const _ = require('underscore');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models');
const common = require('../common');

// TODO: Remove bwctl hack
// This is a ps 3.5/bwctl backwards-compatibility hack
const bwctl_tool_lookup = { // TODO: Remove bwctl hack 
    iperf3: "bwctliperf3",
    iperf2: "bwctliperf2",
    ping: "bwctlping",
    traceroute: "bwctltraceroute",
    tracepath: "bwctltracepath"
};

//catalog of all hosts referenced in member groups keyed by _id

var profile_cache = null;
var profile_cache_date = null;

var host_catalog = {};
var host_groups = {};
var host_groups_details = {};

function load_profile(cb) {
    logger.info("reloading profiles");
    common.profile.getall(function(err, profiles) {
        if(err) return logger.error(err);
        profile_cache = profiles;
        profile_cache_date = Date.now();

    });
}
//load profile for the first time
load_profile();
setInterval(load_profile, 10*60*1000); //reload every 10 minutes

exports.health = function() {
    var status = "ok";
    var msg = null;
    if(!profile_cache) {
        status = "failed";
        msg = "profile cache not loaded yet?";
    } else {
        if(Date.now() - profile_cache_date > 3600*60*1000) {
            status = "failed";
            msg = "profile cache not loaded for more than an hour";
        }
        if(profile_cache.length == 0) {
            status = "failed";
            msg = "profile cache is empty";
        }
    }
    return {msg: msg, status: status};
}

//convert list of UIDs to list of profile objects
function resolve_users(uids) {
    if(!profile_cache) return null; //auth profile not loaded yet?
    var users = [];
    uids.forEach(function(uid) {
        users.push(profile_cache[uid]);
    });
    return users;
}

function convert_tool( tool ) {
    var tool_conversions = {
        "bwctl/nuttcp": "nuttcp",
        "bwctl/iperf": "iperf",
        "bwctl/iperf3": "iperf3"

    };
    // update tool names
    if ( tool in tool_conversions ) {
        tool = tool_conversions[ tool ];
    }
    return tool;

}

function meshconfig_testspec_to_psconfig( testspec, name, psc_tests, schedules ) {
    //var spec = testspec.specs;
    var test = psc_tests[ name ];
    var ps_spec = psc_tests[ name ].spec;
    var spec = ps_spec;
    var service_types = {
        "bwctl": "throughput",
        "owamp": "latencybg",
        "ping": "rtt",
        "traceroute": "trace"
    };

    if ( test.type in service_types ) {
        test.type = service_types[ test.type ];
    }

    var schedule_type = test['schedule_type'];
    var include_schedule = true;
    if ( schedule_type == 'continuous' ) {
        include_schedule = false;
    }

    // change underscores to dashes in all field names in the "spec" stanza
    rename_underscores_to_dashes( spec );


    var interval_seconds = testspec.interval;
    if ( "test-interval" in testspec ) {
        interval_seconds = testspec["test-interval"];
    }

    // this array is a list of fields we will convert from seconds to iso8601
    var iso_fields = [
        "duration",
        "interval",
        "test-interval",
        "report-interval",
        "waittime",
        "slip",
        "timeout"
    ];

    var specifics = testspec.specs; //getting the specs object from testspec
    for(var i in iso_fields) {
        var field = iso_fields[i];
        if ( specifics[ field ] ) {
            psc_tests[ name ].spec[field] = seconds_to_iso8601(specifics[field]);
        }
    }

    if ( spec && "interval" in spec ) {
        rename_field( spec, "interval", "test-interval" );
        delete spec.interval;
    }
    rename_field( spec, "sample-count", "packet-count" );
    rename_field( spec, "udp-bandwidth", "bandwidth" ); // TODO: remove backwards compat hack
    rename_field( spec, "waittime", "sendwait" );
    rename_field( spec, "timeout", "wait" );
    rename_field( spec, "tos-bits", "ip-tos" );
    rename_field( spec, "omit-interval", "omit" );
    if ( "omit" in spec ) {
        spec["omit"] = seconds_to_iso8601 ( spec["omit"] );
    }

    if ( test.type == "rtt" ) { // TODO: figure out a better way to support different field names for different test types
        if ( "packet-interval" in spec ) {
            spec["packet-interval"] = seconds_to_iso8601 ( spec["packet-interval"]  );
        }
        rename_field( spec, "packet-count", "count");
        rename_field( spec, "packet-interval", "interval");
        rename_field( spec, "packet-size", "length");
    } else if ( test.type == "trace" ) {
        rename_field( spec, "packet-size", "length" );
    }

    delete spec.tool;
    delete spec["force-bidirectional"];

    for( var key in spec ) {
        var val = spec[key];

        // do not convert true/false to numbers
        if ( val !== true && val !== false ) {
            // if the value is a number, convert it
            if ( !isNaN( val ) ) {
                val = Number(val);
                spec[key] = val;
            }

        }

    }


    var sched_index = Object.keys(schedules).length;
    var sched_key = "sched-" + sched_index;

    if ( spec[ "test-interval" ] ) {
        schedule_type = "interval";
        include_schedule = true;
        var interval = spec[ "test-interval" ];
        var interval_name = "repeat-" + interval;
        if ( ! schedules[ sched_key ] ) {
            schedules[ sched_key ] = {};
        } 
        schedules[ sched_key ] = {
            "repeat": interval,
            "sliprand": true
        };
    }

    if ( include_schedule ) {


        test._schedule = sched_key;


        // "slip"
        if(("slip" in spec) && (spec.slip != 0) && (schedule_type != 'continuous')) {
            schedules[ sched_key ].slip = spec.slip;
        }
    }
    delete spec[ "slip" ];
    delete spec["random-start-percentage"];


    // rename protocol: udp to udp: true
    if ( ( "protocol" in spec ) && spec.protocol == "udp" ) {
        spec.udp = true;
    }
    delete spec.protocol;


    // handle newer "ipversion" format
    // old: ipv4-only, ipv6-only
    // new: ip-version: 4, 6
    if ("ipv4-only" in spec ) {
        spec["ip-version"] = 4;
        delete spec["ipv4-only"];
    }
    if ("ipv6-only" in spec ) {
        spec["ip-version"] = 6;
        delete spec["ipv6-only"];
    }

    if ( "report-interval" in spec ) {
        rename_field( spec, "report-interval", "interval" );
        delete spec["report-interval"];

    }

    delete spec.type;

}

function rename_underscores_to_dashes( obj ) {
    for(var key in obj ) {
        var newkey = key.replace(/_/g, "-");
        obj[ newkey ] = obj[ key ];
        if (key.match(/_/) ) delete obj[ key ];

    }

}

function rename_field( obj, oldname, newname ) {
    if ( typeof obj == "undefined" ) {
        return;
    }
    if ( oldname in obj ) {
        obj[ newname ] = obj[ oldname ];
        delete obj[ oldname ];
    }
    return obj;

}

function seconds_to_iso8601( dur ) {
    var isoOut = moment.duration(dur * 1000); // moment.duration expects milliseconds
    isoOut = isoOut.toISOString();
    return isoOut;
}


function resolve_testspec(id, cb) {
    db.Testspec.findById(id).exec(cb);
}

//doesn't check if the ma host actually provides ma service
function resolve_ma(host, next, service_types) {
    //for each service, lookup ma host

    async.eachSeries(service_types, function(service, next_service) {

        if(! service.ma ) {
            //use host if not set or set to the host itself
            service.ma = host; 
            next_service();
        } else {
            //find the ma host
            resolve_host(service.ma, function(err, _host) {
                if(err) return next_service(err);
                service.ma = _host;
                next_service();
            });
        }
    }, function(err) {
        next(err, host);
    });
}

function resolve_host(id, cb) {
    db.Host.findById(id).exec(function(err, host) {
        if(err) return cb(err);
        resolve_ma(host, cb);
    });
}

function resolve_hosts(hostgroup, cb) {
    var ids = hostgroup.hosts;
    var service_types = hostgroup.test_service_types;
    db.Host.find({_id: {$in: ids}}).lean().exec(function(err, hosts) {
        if(err) {
            return cb(err);
        }
        async.eachSeries(hosts, 
            function( host, ma_cb ) {
                resolve_ma(host, ma_cb, service_types);
                //ma_cb();
            },
            function(err) {
            //if(err) return cb(err);
            cb(err, hosts);
        });
    });
}

function resolve_hostgroup(id, test_service_types, cb) {
    db.Hostgroup.findById(id).exec(function(err, hostgroup) {
        if(err) return cb(err);
        if(!hostgroup) return cb("can't find hostgroup:"+id);
        //hosts will contain hostid for both static and dynamic (cached by pwacache)
        hostgroup.test_service_types = test_service_types;
        resolve_hosts(hostgroup, function(err, hosts) {
            if(err) return cb(err);
            cb(null, hosts);
        }); 
    });
}

function generate_members(hosts) {
    var members = [];
    if ( Array.isArray( hosts ) ) {
        hosts.forEach(function(host) {
            members.push(host.hostname);
        });
    }
    return members;
}

function get_type(service_type) {
    switch(service_type) {
        case "bwctl":
            return "perfsonarbuoy/"+service_type;
        case "owamp":
            return "perfsonarbuoy/"+service_type;
        case "ping":
            return "pinger";
    }
    return service_type; //no change
}

function generate_mainfo(service, format) {
    var locator = "https://"+service.ma.hostname+"/esmond/perfsonar/archive";

    if ( service.ma.local_ma_url ) {
        locator = service.ma.local_ma_url;
    }

    var type = null;
    if ( format == "pscheduler" ) {
        switch(service.type) {
            case "bwctl": type = "perfsonarbuoy/bwctl"; break;
            case "owamp": type = "perfsonarbuoy/owamp"; break;
            default:
                type = service.type;
        }
    } else {
        type = service.type;

    }

    return generate_mainfo_url(locator, format, type);
}

function generate_mainfo_url(locator, format, type) {

    if ( format != "psconfig" ) {
        return {
            read_url: locator,
            write_url: locator,
            type: get_type(type),
        };
    } else {
        return {
            archiver: "esmond",
            data: {
                url: locator,
                "measurement-agent": "{% scheduled_by_address %}",
            }
        };

    }

}


function set_test_meta( test, key, value ) {
    if ( ! test._meta ) test._meta = {};
    test._meta[key] = value;

}

function get_test_service_type( test ) {
    var type = test.service_type;

    var service = {
        type: type
    };

    return service;

}

function generate_group_members( test, group, test_service_types, type, next, addr_prefix ) {

    var test_service_type = get_test_service_type( test );
    //test_service_types.push( test_service_type );

    if ( ( typeof addr_prefix == "undefined" ) || ( type == "mesh" ) ) {
        addr_prefix = "";
    }
    var group_prefix = addr_prefix.replace("-", "");
    if ( group_prefix == "" ) group_prefix = "a";
    var group_field = group_prefix + "group";

    resolve_hostgroup(group, test_service_types, function(err, hosts) {
        var addr = addr_prefix + "addresses";
        if ( ! ( test.name in host_groups_details ) ) {
            host_groups_details[ test.name ] = {
                "type": type
            };
        }
        if ( ! ( addr in host_groups_details[ test.name ] ) ) {
            host_groups_details[ test.name ][ addr ] = [];
        }


        set_test_meta( test, "_hostgroup", test.name );
        //set_test_meta( test, "_hostgroup", host_groups[ test.name ] );
        set_test_meta( test, "_test",  test.name );

        if ( ( "testspec" in test ) && ("specs" in test.testspec ) && ( "tool" in test.testspec.specs ) ) {
            set_test_meta( test, "_tool", convert_tool( test.testspec.specs.tool ));
        } 

        if(err) return next(err);
        test[ group_field ] = hosts;
        hosts.forEach(function(host) {
            host_catalog[host._id] = host;
            var host_addr;
            if ( host.hostname ) {
                host_addr = host.hostname;

                if ( ! host_groups_details[ test.name ][ addr ].find(o => o.name == host_addr) ) {
                    host_groups_details[ test.name ][ addr ].push(
                        { "name": host.hostname }
                        );

                }
            } else {
                host.addresses.forEach( function( address ) {
                    host_addr = address.address;
                if ( ! host_groups_details[ test.name ][ addr ].find(o => o.name == host_addr) ) {
                    host_groups_details[ test.name ][ addr ].push(
                        { "name": host_addr }
                        );
                }
                });
            }


        });
        next();
    });

};


exports._process_published_config = function( _config, opts, cb ) {
    var format = opts.format;


    //resolve all db entries first
    if(_config.admins) _config.admins = resolve_users(_config.admins);

    var service_type_obj = {};
    _config.tests.forEach( function( tmptest ) {
        service_type_obj[ tmptest.service_type ] = get_test_service_type( tmptest );

    });

    var test_service_types = Object.keys(service_type_obj).map(e => service_type_obj[e]);


    async.eachSeries(_config.tests, function(test, next_test) {


        var type = test.mesh_type;

        if(!test.enabled) return next_test();
        async.parallel([
            function(next) {
                //a group
                if(!test.agroup) return next();
                generate_group_members( test, test.agroup, test_service_types, type, next, "a-" );
            },
            function(next) {
                //b group
                if(!test.bgroup) return next();
                generate_group_members( test, test.bgroup, test_service_types, type, next, "b-" );
            },
            function(next) {
                if(!test.nahosts) return next();
                resolve_hosts(test.nahosts, function(err, hosts) {
                    if(err) return next(err);
                    test.nahosts = hosts;
                    hosts.forEach(function(host) { 
                        host_catalog[host._id] = host; 
                    });
                    next();
                });
            },
            function(next) {
                //testspec
                if(!test.testspec) return next();
                resolve_testspec(test.testspec, function(err, row) {
                    if(err) return next(err);
                    test.testspec = row;

                    //suppress testspecs that does't meet min host version
                    if(!_config._host_version) return next();
                    var hostv = parseInt(_config._host_version[0]);
                    var minver = config.meshconfig.minver[test.service_type];
                    for(var k in test.testspec.specs) {
                        //if minver is set for this testspec, make sure host version meets it
                        if(minver[k]) {
                            if(hostv < minver[k]) delete test.testspec.specs[k]; 
                        }
                    }
                    next();
                });
            },
        ], next_test);
    }, function(err) {
        if(err) return logger.error(err);

        //return exports._process_published_config( _config, opts, cb, format, test_service_types );
        //return exports._process_published_config( _config, opts, cb );


        //meshconfig root template
        var mc = {
            organizations: [],
            tests: [],
            description: _config.name,
            measurement_archives: []
        };

        //psconfig root template
        var psconfig = {
            archives: {},
            addresses: {},
            groups: {},
            tests: {},
            schedules: {},
            tasks: {},
            _meta: {
                "display-name": _config.name
            },

        }

        if(_config.desc) mc.description += ": " + _config.desc;
        if(_config._host_version) mc.description += " (v"+_config._host_version+")";

        //set meshconfig admins
        if(_config.admins) {
            mc.administrators = [];
            _config.admins.forEach(function(admin) {
                if ( ( typeof admin ) != "undefined" ) {
                    mc.administrators.push({name: admin.fullname, email: admin.email});
                }
            });
        }

        //convert services to sites/hosts entries
        //pwa currently doesn't handle the concept of organization
        var org = {
            sites: [],
        };

        var last_ma_number = 0;
        var maHash = {};
        var mc_test_types = {};
        var config_mas = [];
        var config_service_types = [];
        var psc_addresses = {};
        var psc_groups = {};
        // make a list of the psconfig archives
        var psc_archives = {};
        var psc_tests = {};
        var psc_schedules = {};
        var psc_tasks = {};
        var psc_hosts = {};


        _config.tests.forEach(function(test) {
            var service = test.service_type;
            //var maInfo = generate_mainfo(service, format);
            config_service_types.push( service );


        });


        var last_host_ma_number = 0;

        //register sites(hosts)
        for(var id in host_catalog) {
            var extra_mas = {};
            var _host = host_catalog[id];
            var toolkit_url = _host.toolkit_url || "auto";
            var host = {
                addresses: [ _host.hostname ],
                measurement_archives: [ ],
                description: _host.desc||_host.sitename,
                toolkit_url: toolkit_url,
            }
            if(_host.no_agent) host.no_agent = 1;
            //logger.warn(_host.hostname, _host.services.length);
            //
            if ( toolkit_url == "auto" ) {
                // automatically generate the toolkit URL
                var proto = "https://";
                var hostname = _host.hostname;
                var relative_url = "/toolkit/";
                toolkit_url = proto + hostname + relative_url;

            }

            psc_addresses[ _host.hostname ] = {
                "address":  _host.hostname,
                "host": _host.hostname,
                "_meta": {
                    "display-name": _host.desc || _host.sitename,
                    "display-url": toolkit_url
                    // TODO: add org?
                    //"organization": _host.org

                }
            };
            if ( ! ( _host.hostname in psc_hosts) ) psc_hosts[ _host.hostname ]  = {};

            if ( "ma_urls" in _host && _host.ma_urls.length > 0  ) {
                for(var i in _host.ma_urls ) {
                    var extra_url = _host.ma_urls[i];
                    //if ( typeof extra_url == "undefined" ) continue;
                    var maInfo = generate_mainfo_url(extra_url, format, service);
                    var maName = "host-additional-archive" + last_host_ma_number;
                    if ( ! ( extra_url in maHash ) ) {
                        //maHash[extra_url] = maName;
                        extra_mas[maName] = extra_url;
                        last_host_ma_number++;

                    } else {
                        var maType = maHash[extra_url];
                        if ( ( typeof maType ) != "undefined" ) {
                         //   maHash[extra_url] = maType;
                            extra_mas[maType] = extra_url;
                            last_host_ma_number++;
                       }
                    }

                }
            }

            //create ma entry for each service
            test_service_types.forEach(function(service) {
                service.ma = _host;
                if(service.type == "mp-bwctl") return;
                if(service.type == "ma") return;
                if(service.type == "mp-owamp") return;
                if(opts.ma_override) service.ma = { hostname: opts.ma_override }
                mc_test_types[ service.type ] = 1;
                if(!service.ma) {
                    logger.error("NO MA service running on ..");
                    logger.debug(service);
                    return;
                }

                if ( !_host.local_ma && !_config.force_endpoint_mas && !_host.ma_urls ) {
                    return;
                }

                var maInfo = generate_mainfo(service, format);
                var maName = "host-archive" + last_ma_number;
                var url = "";

                if ( format == "psconfig" ) {
                    url = maInfo.data.url;
                } else {
                    url = maInfo.write_url;
                    if( _host.local_ma || _config.force_endpoint_mas ) {

                        host.measurement_archives.push(generate_mainfo(service, format));
                    }
                }

                // Handle host main MA 
                if ( ! ( "archives" in psc_hosts[ _host.hostname ]) ) psc_hosts[ _host.hostname ].archives  = [];
                if ( ! ( "_archive" in _host ) ) _host._archive = [];

                if ( ! ( url in maHash )  ) {
                    if ( ( _host.local_ma || _config.force_endpoint_mas ) ) {
                        psc_archives[ maName ] = maInfo;
                        _host._archive.push(maName);
                        psc_hosts[ _host.hostname ].archives.push( maName );

                        last_ma_number++;
                        maHash[url] = maName;
                    } else if ( url in extra_mas ) {

                    }

                } else {
                    if ( ( _host.local_ma || _config.force_endpoint_mas ) ) {
                    var maType = maHash[url];
                        psc_archives[ maType ] = maInfo;
                    }

                }

                // Handle extra host MAs

                for(var key in extra_mas ) {
                    var maName = key;
                    var url = extra_mas[key];
                    var maInfo =  generate_mainfo_url( url, format, service.type);

                    var maType = maHash[url];
                    if ( psc_hosts[ _host.hostname ].archives.indexOf( maName ) == -1 ) {
                        psc_hosts[ _host.hostname ].archives.push( maName );
                    }
                    if ( ! ( url in maHash ) ) {
                        psc_archives[ maName ] = maInfo;
                        maHash[url] = maName;
                    } else {
                        maName = maType;
                        psc_archives[ maName ] = maInfo;
                        maHash[url] = maName;

                    }
                    if(config_service_types.indexOf(service.type) != -1 && _host._archive.indexOf( maName) == -1) {
                        _host._archive.push(maName);
                        host.measurement_archives.push( maInfo );
                    }

                }


            });
            if (  host.measurement_archives.length == 0 ) {
                delete host.measurement_archives;
            }

            // If there are no archives for this host, delete the 'archives' object

            if ( ( "archives" in psc_hosts[ _host.hostname ] ) &&  psc_hosts[ _host.hostname ].archives.length == 0 ) {
                delete psc_hosts[ _host.hostname ].archives;

            }

                // TODO figure out how to have multiple tests of same type
                // (need unique hostgroup names)

            var site = {
                hosts: [ host ],
                location: {}
            };

            //pull location info (some location- info that comes with sLS isn't allowed for meshconfig
            //so I have to list all that's allowed (v4 host may be ok?)
            ['country', 'street_address', 'city', 'state', 'latitude', 'longitude'].forEach((k)=>{
                site.location[k] = _host.info['location-'+k];
            });
            if(_host.info['location-code']) site.location['postal_code'] = _host.info['location-code'];//odd one
            org.sites.push(site);
        }

        var ma_prefix = "config-archive";
        // init variables for config archives
        var last_config_ma_number = 0;
        var last_test_ma_number = 0;
        var test_mas = [];

        // Get custom MAs (which are defined as raw JSON in a string in the db)
        if ( "ma_custom_json" in _config ) {
            var customString = _config.ma_custom_json;
            var customArchiveConfig;
            if ( customString ) {
                try { 
                    customArchiveConfig = JSON.parse( customString );
                    console.log("customArchiveConfig", customArchiveConfig);
                    // add custom archiver to testspec.
                    var maNames = Object.keys( customArchiveConfig );
                    maNames.forEach( function( maName ) {
                        var archiveDetails = customArchiveConfig[ maName ];
                        test_mas.push(maName);

                    });
                    //psc_archives["asdf"] = customArchiveConfig;
                    psc_archives = _.extend( psc_archives, customArchiveConfig );
                } catch(e) {
                    logger.error("Custom JSON archive did not validate", e, customString);

                }
            }
        }

    

        var ma_prefix = "config-archive";
        if ( "ma_urls" in _config ) {
            for(var i in _config.ma_urls ) {
                var url = _config.ma_urls[i];
                if ( url == "" ) continue;

                var maName = "config-archive" + last_config_ma_number;
                var maName = "config-archive" + last_test_ma_number;
                test_mas.push( maName );
                var maInfo;
                var maType = maHash[url];

                for(var type in mc_test_types ) {
                    maInfo = generate_mainfo_url(url, format, type);
                    if ( ! ( url in maHash ) ) { 
                        psc_archives[ maName ] = maInfo;
                        maHash[url] = maName;

                } else if ( ( typeof maType ) != "undefined" ) {
                    maName = maType;
                    //psc_archives[ maName ] = maInfo;
                    maHash[url] = maName;


                }
                    if ( typeof maInfo.type == "undefined" ) continue;


                    if(config_service_types.indexOf(type) != -1) {
                        config_mas.push( maInfo );
                    }
                    if ( format != "psconfig" ) type = get_type(type);
                    var service = maInfo.type;
                    maInfo.type = type;


                }

                psc_archives[ maName ] = maInfo;

                last_config_ma_number++;
            }
        }

        // Retrieve MA URLs from the _config object

        psconfig.archives = psc_archives;
        psconfig.addresses = psc_addresses;
        psconfig.groups = host_groups_details;
        //psconfig.groups = psc_groups;
        mc.organizations.push(org);
        if ( config_mas.length > 0 ) {
            mc.measurement_archives = config_mas;
        } else {
            delete mc.measurement_archives;
        }


        //now the most interesting part..
        _config.tests.forEach(function(test) {

            if(!test.enabled) return;
            var members = {
                type: test.mesh_type
            };
            switch(test.mesh_type) {
                case "disjoint":
                    members.a_members = generate_members(test.agroup);
                    members.b_members = generate_members(test.bgroup);
                    break;
                case "mesh":
                    members.members = generate_members(test.agroup);
                    break;
            }
            if(test.nahosts && test.nahosts.length > 0) {
                members.no_agents = generate_members(test.nahosts);
                members.no_agents.forEach( function( host ) {
                    psconfig.addresses[ host ][ "no-agent" ] = true;
                });
            }


            var name = test.name;
            var testspec = test.testspec;



            var config_archives = _config.ma_urls;


            psc_tests[ name ] = {
                "type": test.service_type,
                "spec": {},
            };

            psc_tests[ name ].spec = testspec.specs || {};
            psc_tests[ name ].schedule_type = testspec.schedule_type || test.service_type;


            if ( format == "psconfig" ) {
                psc_tests[ name ].spec.source = "{% address[0] %}";
                psc_tests[ name ].spec.dest = "{% address[1] %}";
                meshconfig_testspec_to_psconfig( testspec, name, psc_tests, psc_schedules );
            }

            var interval = psc_tests[ name ].spec["test-interval"];

            var current_test = psc_tests[name];
            
            var include_schedule = true;

            if ( current_test.type == "latencybg" ) {
               if ( current_test.schedule_type == "interval" ) {
                current_test.type = "latency";
                //delete current_test.spec.interval;
                delete current_test.spec.duration;
               } else {
                   include_schedule = false;
                   //delete psc_tasks[ name ].tools; (see below tools section)



               }
            }

            delete current_test.schedule_type;
            delete current_test.spec["test-interval"];

            if ( typeof (test._meta)  != "undefined" && ("_meta" in test ) ) {

                psc_tasks[ name ] = {
                    "group": test._meta._hostgroup,
                    "test": test._meta._test,
                    "archives": test_mas,
                    "_meta": {
                        "display-name": name

                    }
                };

            }

            if ( include_schedule ) {
                psc_tasks[ name ].schedule = psc_tests[ name ]._schedule;
            }
            delete psc_tests[ name ]._schedule;

            if ( interval ) {
                //psc_tasks[ name ].schedule = "repeat-" +  interval;

            }

            delete psc_tests[ name ].spec["test-interval"];

            if ( include_schedule && ( "_meta" in test ) &&  ( "_tool" in test._meta ) &&  typeof test._meta._tool != "undefined" ) {
                psc_tasks[ name ].tools = [ test._meta._tool ];
                add_bwctl_tools( psc_tasks[ name ] );

            }


            var parameters = test.testspec.specs;

            if ( format != "psconfig" ) parameters.type = get_type(test.service_type);

            if ( "type" in parameters &&  parameters.type == "perfsonarbuoy/owamp" ) {
                if ( parameters && "tool" in parameters ) {
                    // if tool is not owping, drop this test
                    if ( parameters.tool != "owping" ) {
                        return;
                    } else {
                        // delete the tool parameter because meshconfig doesn't support it
                        delete parameters.tool;
                    }
                }
                // drop the test from meshconfig format if it has interval/duration parameters
                if ( "interval" in parameters || "duration" in parameters ) {
                    return;
                }
            }

            mc.tests.push({
                members: members,
                parameters: parameters,
                description: test.name
            });
        });

        psconfig.tests = psc_tests;
        psconfig.schedules = psc_schedules;
        psconfig.tasks = psc_tasks;
        psconfig.hosts = psc_hosts;

        //all done
        if ( format == "psconfig" ) {
            cb(null, psconfig);
        } else {
            cb(null, mc);
        }
    });

};

exports.generate = function(_config, opts, cb) {

    host_groups = {};
    host_groups_details = {};
    host_catalog = {};

    return exports._process_published_config( _config, opts, cb );
}

// TODO: Remove bwctl hack
// This function adds bwctl backwards-compatible tools to the list of tools
function add_bwctl_tools ( task ) {
    if ( ! ("tools" in task ) ) {
        return;
    }
    for( var i in task.tools ) {
        var tool = task.tools[i];
        if ( ( tool in bwctl_tool_lookup ) && ( ! (bwctl_tool_lookup[ tool ] in task.tools ) ) ) {
            task.tools.unshift( bwctl_tool_lookup[ tool ] );

        }

    }

}

function log_json( json_text ) {
    logger.debug(JSON.stringify(json_text, null, 3));
}
