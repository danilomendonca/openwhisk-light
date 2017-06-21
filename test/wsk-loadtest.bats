#!/usr/bin/env bats
# stress test OW action invocation (including concurrency and potentially queueing)
# uses https://www.npmjs.com/package/loadtest

@test "stress test of action invocation with loadtest" {
  APIHOST=$(wsk property get --apihost | awk '{print $4}')
  [[ ! $APIHOST = http* ]] && APIHOST=https://$APIHOST
  echo $APIHOST
  errors=`loadtest -c 5 -n 20 -k -m POST -H "Authorization: basic $(wsk property get --auth | awk '{print $3}' | base64 -w 0)" $APIHOST/api/v1/namespaces/whisk.system/actions/utils/echo?blocking=true | grep "Total errors" | cut -d: -f 4`
  echo $errors
  [ $errors -eq 0 ]
}