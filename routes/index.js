var express = require('express');
var router = express.Router();
var openwhisk = require('openwhisk');
var bodyParser = require('body-parser');

const LocalClient = require('./../localclient.js');
const messages = require('./../messages');

const config = require("./../config.js") || {}; // holds node specific settings, consider to use another file, e.g. config.js as option
const burstOWService = process.env.BURST_OW_SERVICE || config.burstOWService; // max number of containers per host

var dockerhost = process.env.DOCKER_HOST || function() {
    throw "please set the DOCKER_HOST environmental variable, e.g. http://${MY_HOST_WITH_DOCKER_REST}:2375";
}();

var openwhiskApi = process.env.OPENWHISK_API || function() {
    throw "please set the OPENWHISK_API environmental variable pointing to openwhisk global, e.g. https://openwhisk.ng.bluemix.net/api/v1";
}();

console.log("DOCKERHOST: " + dockerhost);
console.log("OPENWHISK_API: " + openwhiskApi);

var client = new LocalClient({dockerurl: dockerhost});
var stringify = require('json-stringify-safe');

var request = require('request');
var url = require('url');

var PouchDB = require('pouchdb');
var db = new PouchDB('owlocal.db');

router.use(bodyParser.json());

/*
 * OpenWhisk action invoke local implementation
 * 
 * 
 * Invoke action on openwhisk local client
 * 
 * 		if client throws "action missing" exception
 * 			get specified action from global openwhisk
 * 			update local action registry
 * 			update bursting service action registry
 * 			invoke action on openwhisk local client and return result
 * 
 * 		if client throws "total capacity limit" exception
 * 			delegate action to bursting service and return result
 */
router.post('/namespaces/:namespace/actions/:actionName', function(req, res) {
  console.log("req: " + stringify(req));
  console.log("PATH: " + req.path);
  console.log("params: " + JSON.stringify(req.params));
  console.log("namespace: " + req.params.namespace);
  console.log("actionName: " + req.params.actionName);

  console.log("BODY: " + JSON.stringify(req.body));
  console.log("headers: " + JSON.stringify(req.headers));

  var start = new Date().getTime();
  
  function storeAndRespond(result){
	  console.log("raw result: " + JSON.stringify(result));
      result = buildResponse(req, start, result);
      
      //store activation in local db (move to function to avoid code duplication)
      db.post(result).then(function (response) {
   	   result["activationId"] = response.id;
   	   console.log("returning response: " + JSON.stringify(result));
   	   res.send(result);
      }).catch(function (err) {
   	   console.log(err);
   	   res.status(502).send(buildResponse(req, start, {}, err));
      });
  }

  client.invoke(req.params.actionName, req.body)
    .then((result) => {
       storeAndRespond(result);
    })
    .catch(function(e) {
      if(e == messages.ACTION_MISSING_ERROR){
        console.log("getting action " + req.params.actionName + " from " + openwhiskApi);
        getAction(req.params.namespace, req.params.actionName, req)
        .then((action)=>{
                console.log("got action: " + JSON.stringify(action));
                console.log("Registering action under openwhisk edge " + JSON.stringify(action));

                client.create(req.params.actionName, action)
                .then((result) => {
                   console.log("action " + req.params.actionName + " registered: " + JSON.stringify(result));
                   client.invoke(req.params.actionName, req.body)
                   .then((result) => {
                	   storeAndRespond(result);
                   })
                   .catch(function(error) {
                     console.log("Invoke error: " + error.error);
	                 var iResponse = buildResponse(req, start, {}, error);
	                 console.log("returning: " + JSON.stringify(iResponse));
                     res.status(502).send(iResponse);
                     console.log("done");
                     return;
                   });
                })
                .catch(function(e) {
                  console.log(e);
                  res.status(500).send(e);
                  return;
                })

              if(burstOWService){
                client.request("PUT", burstOWService + req.path, req.body).then(function(result){
                  console.log("--- RESULT: " + JSON.stringify(result));
                  res.send(result);
                }).catch(function(e) {
                  console.log("--- ERROR registering action in bursting!: " + JSON.stringify(e));
                });
              }

        })
        .catch(function (err) {
            console.log("action get error: " + err);
            res.status(404).send(err);
            return;
        });

      } else if(e == messages.TOTAL_CAPACITY_LIMIT){
        console.log("Maximal local capacity reached, delegating action invoke to bursting ow service");

        if(burstOWService){
          client.request("POST", burstOWService + req.path, req.body).then(function(result){
            console.log("--- RESULT: " + JSON.stringify(result));
            storeAndRespond(result);
          }).catch(function(e) {
            console.log("--- ERROR: " + JSON.stringify(e));
            res.status(404).send(e);
          });
        }else{
          res.status(404).send(e);
        }
      }else{
        res.status(502).send(buildResponse(req, start, {}, e));
      }
    })
});

/*
 * Action get name. Also currently used to update openwhisk local actions registry
 * 
 * Get action from openwhisk global
 * Update local actions registry
 * Update bursting service actions registry
 */
router.get('/namespaces/:namespace/actions/:actionName', function(req, res) {
	console.log("BODY: " + JSON.stringify(req.body));
	var start = new Date().getTime();

	console.log("getting action " + req.params.actionName + " from " + openwhiskApi);
	getAction(req.params.namespace, req.params.actionName, req)
	.then((action)=>{
	    console.log("got action: " + JSON.stringify(action));
	    console.log("Registering action under openwhisk edge " + JSON.stringify(action));

        client.create(req.params.actionName, action)
        .then((result) => {
           console.log("action " + req.params.actionName + " registered");

           if(burstOWService){
             client.request("PUT", burstOWService + req.path, req.body).then(function(result){
               console.log("--- RESULT: " + JSON.stringify(result));
               res.send(action);
             }).catch(function(e) {
               console.log("--- ERROR registering action in bursting service: " + e);
               res.status(502).send(buildResponse(req, start, {}, e));
             });
           }else{
         	 res.send(action);
           }
        })
        .catch(function(e) {
          console.log(e);
          res.status(502).send(buildResponse(req, start, {}, e));
        })
	})
	.catch(function (err) {
        console.log("action get error: " + err);
        res.status(502).send(buildResponse(req, start, {}, err));
	});
});

/*
 * Delegate action delete to openwhisk global
 * 
 * delete action from local registry
 * delete action from bursting service
 */
router.delete('/namespaces/:namespace/actions/:actionName', function(req, res) {
    var api_key = from_auth_header(req);
    var start = new Date().getTime();
    
    client.request("DELETE", openwhiskUrl + req.path, req.body, {"authorization": req.get("authorization")}).then(function(result){
      client.delete(req.params.actionName);
      	if(burstOWService){
          client.request("DELETE", burstOWService + req.path, req.body).then(function(deleted){
            res.send(buildResponse(req, start, result));
          }).catch(function(e) {
            console.log("--- ERROR deleting action in bursting service: " + e);
            res.status(502).send(buildResponse(req, start, {}, e));
          });
        }else{
        	res.send(buildResponse(req, start, result));
        }
      }).catch(function(e) {
        console.log("--- ERROR: " + JSON.stringify(e));
        res.status(502).send(buildResponse(req, start, {}, e));
      });
});

function getAction(namespace, actionName, req){
    var api_key = from_auth_header(req);
    var ow_client = openwhisk({api: openwhiskApi, api_key});

    return new Promise(function(resolve,reject) {
        ow_client.actions.get({actionName, namespace})
            .then(function (action) {
                console.log("Got action from " + openwhiskApi + ": " + JSON.stringify(action));
                resolve(action);
            })
            .catch((e) => {
                reject(e);
            });
    });
}

function from_auth_header(req) {
  var auth = req.get("authorization");
  auth = auth.replace("Basic ", "");
  auth = new Buffer(auth, 'base64').toString('ascii');
  return auth;
}

function buildResponse(req, start, result, error){
  var end = new Date().getTime();
  var response;
  if(error !== undefined){
    console.log("error.error.error: " + error.error.error);
    response = {
        "result": {
             error: error.error.error
        },
        "status": "action developer error",
        "success": false
    };
  }else{
	if(req.query.result === "true"){
		return result;
	}else{
	    response = {
	        result,
	        "status": "success",
	        "success": true
	    };
	}
  }

  return {
    duration: (end - start),
    end,
    "logs": [],
    name: req.params.actionName,
    namespace: req.params.namespace,
    "publish": false,
    response,
    start,
    "subject": "kpavel@il.ibm.com",
    "version": "0.0.4"
  }
}


module.exports = router;