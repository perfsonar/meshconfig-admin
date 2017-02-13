
#I have to move most of the app under mca-admin so that docker won't complain about *outside of context*
echo "preparing mca-admin"
rm -rf mca-admin/tmp
mkdir mca-admin/tmp
cp -r ../../api mca-admin/tmp
cp -r ../../ui mca-admin/tmp
cp -r ../../package.json mca-admin/tmp
rm -rf mca-admin/tmp/api/config

docker build mca-admin -t soichih/mca-admin
docker tag soichih/mca-admin soichih/mca-admin:3.0
docker push soichih/mca-admin

echo "preparing mca-pub"
rm -rf mca-pub/tmp
mkdir mca-pub/tmp
cp -r ../../api mca-pub/tmp
cp -r ../../package.json mca-pub/tmp
rm -rf mca-pub/tmp/api/config

docker build mca-pub -t soichih/mca-pub
docker tag soichih/mca-pub soichih/mca-pub:3.0
docker push soichih/mca-pub