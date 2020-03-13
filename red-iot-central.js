module.exports = function(RED) {
    "use strict";
    
    var iotHubTransport;
    var Client = require('azure-iot-device').Client;
    var Message = require('azure-iot-device').Message;
    var ProvisioningTransport = require('azure-iot-provisioning-device-mqtt').Mqtt;
    var SymmetricKeySecurityClient = require('azure-iot-security-symmetric-key').SymmetricKeySecurityClient;
    var X509Security = require('azure-iot-security-x509').X509Security;
    var ProvisioningDeviceClient = require('azure-iot-provisioning-device').ProvisioningDeviceClient;
    var hubClient;
    var gTwin = null;
    var idScope ;
    var registrationId ;
    var symmetricKey ;
    var deviceConnected;
    var deviceRegistering = false;
    var util = require('util');
    var external_msg;
    var auth;
    var cert2;

    function IoTCentralConfigNode(config) {
        RED.nodes.createNode(this,config);
        this.log("creating node.");
        
        this.scopeid = config.scopeid;
        this.deviceid = config.deviceid;
        this.primarykey = config.primarykey;
        this.commands = [config.command1, config.command2,  config.command3, config.command4, config.command5]; 
        this.transport = config.transport;
        this.auth = config.auth;
        this.certfile = config.certfile;
        this.certkeyfile = config.certkeyfile;
        this.passwordi = config.passwordi;

        hubClient = null;
        
        var node = this;
        var flowContext = this.context().flow;

        node.on('input', function(msg) {
            
            external_msg = msg;

            node.log("Transport:" + node.transport);
            if(node.transport === "mqtt"){
                iotHubTransport = require('azure-iot-device-mqtt').Mqtt;
            } else if(node.transport === "amqp"){
                iotHubTransport = require('azure-iot-device-amqp').Amqp;
            } else {
                iotHubTransport = require('azure-iot-device-http').Http;
            }

            node.log("Auth:" + node.auth);
            const fs = require('fs')
            if(node.auth === "x509"){
                if (!fs.existsSync(node.certfile) || !fs.existsSync(node.certkeyfile)) {
                    node.error("When using X509 you must specify a device certificate and private key file.");
                    node.send();
                    return;
                }
                else{
                    cert2 = {
                        cert : fs.readFileSync(node.certfile, 'utf-8').toString(),
                        key : fs.readFileSync(node.certkeyfile, 'utf-8').toString(),
                        passphrase: node.passwordi
                    };
                }
            } 
            
            node.log("input received.");
            
            deviceConnected= (hubClient != null);

            node.log("deviceConnected: " + deviceConnected);
            node.log("deviceRegistering: " + deviceRegistering);

            if (!deviceConnected && !deviceRegistering ){
                deviceRegistering = true;
                var provisioningHost = 'global.azure-devices-provisioning.net';
                var idScope = node.scopeid;
                var registrationId = node.deviceid;
                var symmetricKey = node.primarykey;
                
                var provisioningSecurityClient;
                if (node.auth === "x509"){
                    provisioningSecurityClient = new X509Security(registrationId, cert2);
                }
                else {
                    provisioningSecurityClient = new SymmetricKeySecurityClient(registrationId, symmetricKey);
                }
                
                node.log("IoT Central registering: "+ idScope + " , " + registrationId);

                var provisioningClient = ProvisioningDeviceClient.create(provisioningHost, idScope, new ProvisioningTransport(), provisioningSecurityClient);
                
                try {
                    provisioningClient.register((err, result) => {
                    if (err) {
                        this.resetConnectionsStatusToOrigin();
                        node.error('Error registering device: ' + err);
                    } else {
                        try {
                            node.log('Registration succeeded');
                            node.log('Assigned hub=' + result.assignedHub);
                            node.log('DeviceId=' + result.deviceId);
                            
                            var connectionString;
                            if(node.auth === "x509"){
                                connectionString = 'HostName=' + result.assignedHub + ';DeviceId=' + result.deviceId + ";x509=true" ;
                            }
                            else{
                                connectionString = 'HostName=' + result.assignedHub + ';DeviceId=' + result.deviceId + ';SharedAccessKey=' + symmetricKey;
                            }
                            node.log(connectionString);
                            
                            hubClient = Client.fromConnectionString(connectionString, iotHubTransport);
                            if(node.auth === "x509") hubClient.setOptions(cert2);
                            hubClient.open(this.connectCallback2);
                        } catch (error) {
                            node.log("Error open the client connection: " + error.message);
                        }
                    }
                });
                } catch (error) {
                    this.resetConnectionsStatusToOrigin();
                    node.error('Error in register: ' + error.message);
                }
                
            }
            else {node.log("IoT Central already registered or registering.");}

            if (deviceConnected && !deviceRegistering)
            {
                this.sendToCloud(msg);
            }
        });

        this.resetConnectionsStatusToOrigin = function(){
            deviceRegistering = false;
            deviceConnected = false;
            hubClient = null;
        };

        this.on('close', function() {
            node.log("Close event raised.");
            if(hubClient){
                hubClient.close();
                hubClient = null;
            }
        });

        this.connectCallback2 = (err) => {
            if (err) {
                node.log("Device could not connect to Azure IoT Central: ${err.toString()}");
              } else {
                node.log("Device successfully connected to Azure IoT Central");
                
                if(node.transport !== "https"){
                    this.addCommands();

                    hubClient.getTwin((err, twin) => {
                        if (err) {
                            node.log(`Error getting device twin: ${err.toString()}`);
                        } else {
                            node.log("Setting Twins");
                            gTwin = twin;
                            
                            this.handleSettings(external_msg);

                            this.setConnectedAndSendToCloud();
                        }
                    });
                } else {
                    this.setConnectedAndSendToCloud();
                }
              }
        };

        this.setConnectedAndSendToCloud = function() {
            deviceConnected = true;
            deviceRegistering = false;

            node.log("sending data in https for the first time ...");
            this.sendToCloud(external_msg);
        };

        this.addCommands = function(){
            if(node.commands == null || node.commands.length == 0)
            {
                node.log("no commands to set. ");
            }
            else{
                node.commands.forEach(command => {
                    if(command != ""){
                        try {
                            node.log("Setting onDeviceMethod on command: " + command);
                            hubClient.onDeviceMethod(command, flowContext.get(command));
                        } catch (error) {
                            let errormessage = `You must add a Java Script node (and run it) with 
                                myCommand(request, response){
                                    //your code here
                                    data = ..;
                                    response.send(200, data , (err) => {
                                        ...
                                    });
                                };
                                flow.set('${command}',myCommand);`;

                            node.error(errormessage);
                        }
                    }
                });
            }
        };

        this.sendTelemetry = function sendTelemetry(msg) {
            var data = JSON.stringify(msg.payload);
            var message = new Message(data);
            message.contentType = "application/json";
            message.contentEncoding = "utf-8";
            node.log ("Sending telemetry ...");
            hubClient.sendEvent(message, (err, res) => { 
                var m = `Sent message: ${message.getData()}`;
                if(err)
                { 
                    m = m + `; error: ${err.toString()}`;
                }
                if(res)
                {
                    m = m + `; status: ${res.constructor.name}`
                }
                node.log(m);
                node.log ("... sent.");
                external_msg.payload = m;
                node.send(external_msg);
                }
              );
        };
        
        this.sendDeviceReportedProperties = function sendDeviceProperties(propsToSend) {
            node.log("Sending reported properties (device->cloud)");
            node.log("Propertie to send: " + util.inspect(propsToSend));
            
            if(gTwin !== null && gTwin !== undefined){
                node.log("Preparing for sending ...");    
                gTwin.properties.reported.update(propsToSend, (err) => 
                    {
                        console.log(`Sent device reported properties: ${JSON.stringify(propsToSend)}; ` + (err ? `error: ${err.toString()}` : `status: success`));
                        external_msg.payload = "Sent reported (device->cloud) properties:" + JSON.stringify(propsToSend);
                        node.send(external_msg)
                    }
                );
            }
            else {
                node.error("**** twin is null we cannot send properties");
            }
        };

        this.sendToCloud = function sendToCloud(msg){
             var reportedProps = msg.payload["reported.properties"];
             if(reportedProps){
                 node.log("Received reported properties");
                    if(gTwin !== null && gTwin !== undefined){
                        this.sendDeviceReportedProperties(reportedProps);
                    } else { node.log("Twin is null. We can not send Reported properties.")}
             }
             else{
                 node.log("received telemetry");
                 if(msg !== null && msg !== undefined 
                    && msg.payload !== "") 
                    this.sendTelemetry(msg)
                else if(msg.payload === "") {
                    msg.payload = "Connected to IoT Cental; no message sent.";
                    node.send(msg);
                }
                else{ 
                    node.log("... but this.msg is null or undefined");
                    msg.payload = "Connected to IoT Cental; message is null.";
                    node.send(msg);
                }
             }
        };

        this.handleSettings = function handleSettings(msg) {
            node.log("handling desired properties");
            
            gTwin.on('properties.desired', function (desiredChange) {
                node.log("desired changed!");
                for (let setting in desiredChange) {
                    node.log(`Received setting: ${setting}: ${desiredChange[setting].value}`);
                    if(desiredChange[setting].value != undefined){
                        var fun = flowContext.get(setting + "-handler");
                        if(fun !== undefined){
                            fun(desiredChange[setting].value);
                            msg.payload = `Set desired prop (Cloud->Device): ${setting}: ${desiredChange[setting].value}`;
                            node.send(msg);
                        }
                    }
                }
            });
        };
    };

    RED.nodes.registerType("Azure IoT Central",IoTCentralConfigNode);
}