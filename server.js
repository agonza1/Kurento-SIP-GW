/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser')
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
var sip = require('./sipstack.js');
var config = require('./config');
var uuid = require('uuid/v1');
var util = require('util');
var transform = require('sdp-transform');


var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Management of sessions
 */
app.use(cookieParser());

var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});

app.use(sessionHandler);

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};

var kurentoClient = null;

/*
 * Server startup
 */
var asUrl = url.parse(config.kurento.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento SIP GW');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
    console.log('Call timeout ' + config.maxCallSeconds + ' seconds');
    console.log('Maximum concurent calls ' + config.maxConcurentCalls);
});

function kurentoPipelineRelease(sessionId){
  console.log('Stop session ID '+sessionId);
  stopFromBye(sessionId);
}


sip.init(kurentoPipelineRelease);


var wss = new ws.Server({
    server : server,
    path : '/sip-gw'
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
    var sessionId = null;
    var request = ws.upgradeReq;
    var response = {
        writeHead : {}
    };




    sessionHandler(request, response, function(err) {
        //sessionId = request.session.id;
        sessionId = uuid();
        console.log('Connection received with sessionId ' + sessionId);
    });

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'start':
            //sessionId = request.session.id;
            sessions[sessionId]={
              'ws': ws
            };
            start(sessionId, ws, message.from,message.to,message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                }
                ws.send(JSON.stringify({
                    id : 'startResponse',
                    sdpAnswer : sdpAnswer
                }));
            });
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;
        case 'sendDtmf':
            sendDtmf(sessionId, message.dtmf);
            break;
        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(config.kurento.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + config.kurento.ws_uri);
            return callback("Could not find media server at address" + config.kurento.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function start(sessionId, ws, from,to, sdpOffer, callback) {
    if (!sessionId) {
        return callback('Cannot use undefined sessionId');
    }


   console.log(sessionId +"Concurent calls : " + Object.keys(sessions).length +"/"+ config.maxConcurentCalls + util.inspect(sessions) );
    if(Object.keys(sessions).length > config.maxConcurentCalls){

        return callback('Unable to start call due to server concurrent capacity limit');
    }

    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {

            if (error) {
                return callback(error);
            }

            createMediaElements(sessionId,pipeline, ws,from,to, function(error, webRtcEndpoint,rtpEndpoint) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }
                console.log("Collect Candidates");
                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }
                console.log("connect media element");

                connectMediaElements(webRtcEndpoint,rtpEndpoint, function(error) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    webRtcEndpoint.on('OnIceCandidate', function(event) {
                        var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });

                  //  sdpOffer = removeUnWantedCodec(sdpOffer);

                    webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {

                        console.log("Sdp Answer WebRTC Endpoint " + sdpAnswer);
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }
/*
                        sessions[sessionId] = {
                            'pipeline' : pipeline,
                            'webRtcEndpoint' : webRtcEndpoint
                        }
                        */
                        sessions[sessionId].pipeline = pipeline;
                        sessions[sessionId].webRtcEndpoint = webRtcEndpoint;

                        return callback(null, sdpAnswer);
                    });

                    webRtcEndpoint.gatherCandidates(function(error) {
                        if (error) {
                            return callback(error);
                        }
                    });
                });
              });
        });
    });
}


function getIPAddress() {
  return config.serverPublicIP;
}

function replace_ip(sdp, ip) {
    if (!ip)
      ip = getIPAddress();
    console.log("IP " + ip);
    console.log("sdp init : "+sdp);

   var sdpObject = transform.parse(sdp);
   sdpObject.origin.address = ip;
   sdpObject.connection.ip = ip;
   var sdpResult = transform.write(sdpObject);
   console.log("sdp result : "+sdpResult);
   return sdpResult;
}

function mungleSDP(sdp){
  mugleSdp = sdp;
  var mugleSdp =  sdp.replace(new RegExp("RTP/AVPF", "g"),  "RTP/AVP");
//  var mugleSdp =  mugleSdp.replace(new RegExp("104", "g"),  "96");
  var h264Payload = sip.getH264Payload(sdp);
  mugleSdp+="a=fmtp:"+h264Payload+" profile-level-id=42801F\n";
  return mugleSdp;
}

function prettyJSON(obj) {
    console.log(JSON.stringify(obj, null, 2));
}


/*Not yet working*/
function removeUnWantedCodec(sdp){
   console.log("removeUnWantedCodec");
   var sdpObject = transform.parse(sdp);

   prettyJSON(sdpObject);

   console.log("RTP lenght"+sdpObject.media[1].rtp.length);
   var newRTP = [];
   for (var i=0; i < sdpObject.media[1].rtp.length ; i++){
     console.log("Media 1 Codec  : "+sdpObject.media[1].rtp[i].codec);
     if (sdpObject.media[1].rtp[i].codec=="H264"){
         newRTP.push(sdpObject.media[1].rtp[i]);
         break;
     }
   }
   var payloadH264=newRTP[0].payload;
   var newFmtp = [];
   for (var i=0; i < sdpObject.media[1].fmtp.length ; i++){
     console.log("fmtp : "+sdpObject.media[1].fmtp[i].payload);
     if (sdpObject.media[1].fmtp[i].payload == payloadH264){
         newFmtp.push(sdpObject.media[1].fmtp[i]);
     }
   }

   var newRtcpFb=[];
   for (var i=0; i < sdpObject.media[1].rtcpFb.length ; i++){
     console.log("rtcpFb  : "+sdpObject.media[1].rtcpFb[i].payload);
     if (sdpObject.media[1].rtcpFb[i].payload == payloadH264){
         newRtcpFb.push(sdpObject.media[1].rtcpFb[i]);
     }
   }

   sdpObject.media[1].rtp=newRTP;
   sdpObject.media[1].fmtp=newFmtp;
   sdpObject.media[1].rtcpFb=newRtcpFb;
   sdpObject.media[1].payloads=payloadH264.toString();

   prettyJSON(sdpObject);
   var sdpResult = transform.write(sdpObject);
   console.log("sdp result : "+sdpResult);
   return sdpResult;
}

function createMediaElements(sessionId,pipeline, ws,from,to , callback) {
    pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
        if (error) {
            return callback(error);
        }

        pipeline.create('RtpEndpoint', function(error, rtpEndpoint){
            if (error) {
                return callback(error);
            }
            createSipCall(sessionId,from+"@"+getIPAddress(),to,rtpEndpoint,function(error){
                if (error) {
                  return callback(error);
                }

                return callback(null, webRtcEndpoint, rtpEndpoint);
            });

        });
    });
}


function connectMediaElements(webRtcEndpoint, rtpEndpoint,callback) {
    rtpEndpoint.connect(webRtcEndpoint, function(error) {
        if (error) {
            return callback(error);
        }
        webRtcEndpoint.connect(rtpEndpoint,function (error){
          if (error) {
              return callback(error);
          }
          return callback(null);
        });
    });
}


function createSipCall(sessionId,from,to,rtpEndpoint,callback){
      rtpEndpoint.generateOffer(function(error, sdpOffer) {
        var modSdp =  replace_ip(sdpOffer);
        modSdp = mungleSDP(modSdp);
        sip.invite (sessionId,from,to,modSdp,function (error,remoteSdp){
          if (error){
            return callback(error);
          }
          rtpEndpoint.processAnswer(remoteSdp,function(error){
            if (error){
              return callback(error);
            }
            // Insert EnCall timeout
            setTimeout(function(){
              console.log("EndCall Timeout "+sessionId);
              sip.bye(sessionId);stopFromBye(sessionId);}
              ,config.maxCallSeconds*1000);
            return callback(null);
          });
        });
      });
}

function stop(sessionId) {
    sip.bye(sessionId);
    if (sessions[sessionId]) {
        var pipeline = sessions[sessionId].pipeline;
        if (pipeline != undefined){
          console.info('Releasing pipeline');
          pipeline.release();
        }
        delete sessions[sessionId];
        delete candidatesQueue[sessionId];
    }
}

function stopFromBye(sessionId) {
    if (sessions[sessionId]) {
      var ws = sessions[sessionId].ws;
      if (ws != undefined){
        ws.send(JSON.stringify({
            id : 'stopFromBye'
        }));
      }
      var pipeline = sessions[sessionId].pipeline;
      if (pipeline != undefined){
        console.info('Releasing pipeline');
        pipeline.release();
      }
      delete sessions[sessionId];
      delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);
    if (sessions[sessionId]!=undefined && sessions[sessionId].webRtcEndpoint!=undefined) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

function sendDtmf(sessionId, dtmf){
    sip.infoDtmf(sessionId,dtmf);
}

app.use(express.static(path.join(__dirname, 'static')));
