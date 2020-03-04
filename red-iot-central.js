module.exports = function(RED) {
    "use strict";
    
    var iotHubTransport = require('azure-iot-device-mqtt').Mqtt;
    var Client = require('azure-iot-device').Client;
    var Message = require('azure-iot-device').Message;
    var ProvisioningTransport = require('azure-iot-provisioning-device-mqtt').Mqtt;
    var SymmetricKeySecurityClient = require('azure-iot-security-symmetric-key').SymmetricKeySecurityClient;
    var ProvisioningDeviceClient = require('azure-iot-provisioning-device').ProvisioningDeviceClient;
    var hubClient;
    var gTwin = null;
    var idScope ;
    var registrationId ;
    var symmetricKey ;
    var deviceConnected;
    var util = require('util');
    var external_msg;

    function IoTCentralConfigNode(config) {
        RED.nodes.createNode(this,config);
        this.log("creating node.");
        
        this.scopeid = config.scopeid;
        this.deviceid = config.deviceid;
        this.primarykey = config.primarykey;
        this.commands = [config.command1, config.command2,  config.command3, config.command4, config.command5]; 
        this.properties = [config.property1, config.property2,  config.property3, config.property4, config.property5]; 

        hubClient = null;
        
        var node = this;
        var flowContext = this.context().flow;

        node.on('input', function(msg) {
            external_msg = msg;
            
            // Register IoT Central with Scope, etc...
            this.log("input received.");
            deviceConnected= (hubClient != null);

            if(!deviceConnected){
                var provisioningHost = 'global.azure-devices-provisioning.net';
                var idScope = node.scopeid;
                var registrationId = node.deviceid;
                var symmetricKey = node.primarykey;
                var provisioningSecurityClient = new SymmetricKeySecurityClient(registrationId, symmetricKey);
                var provisioningClient = ProvisioningDeviceClient.create(provisioningHost, idScope, new ProvisioningTransport(), provisioningSecurityClient);
                
                this.log("IoT Central registering: "+ idScope + " , " + registrationId + " , " + symmetricKey)
                provisioningClient.register((err, result) => {
                    if (err) {
                        this.log('Error registering device: ' + err);
                    } else {
                        node.log('Registration succeeded');
                        node.log('Assigned hub=' + result.assignedHub);
                        node.log('DeviceId=' + result.deviceId);
                        var connectionString = 'HostName=' + result.assignedHub + ';DeviceId=' + result.deviceId + ';SharedAccessKey=' + symmetricKey;
                        hubClient = Client.fromConnectionString(connectionString, iotHubTransport);
                        hubClient.open(this.connectCallback2);
                    }
                });
                
            }
            else {this.log("IoT Central already registered.");}

            // Now send real data (telemetry or properties)
            if(deviceConnected)
            {
                this.sendToCloud(msg);
            }
        });

        this.connectCallback2 = (err) => {
            if (err) {
                node.log("Device could not connect to Azure IoT Central: ${err.toString()}");
              } else {
                node.log("Device successfully connected to Azure IoT Central");
                
                // add callback function
                this.addCommands();

                // Get device twin from Azure IoT Central
                hubClient.getTwin((err, twin) => {
                    if (err) {
                        node.log(`Error getting device twin: ${err.toString()}`);
                    } else {
                        //node.log(`device twin: ${util.inspect(twin)}`);
                        node.log("Setting Twins");
                        gTwin = twin;
                        //node.log(`device twin: ${util.inspect(Twin)}`);
                        // Send device properties once on device start up.
                        /*
                        var properties = {
                            state: 'true'
                        };
                        sendDeviceProperties(twin, properties);
                        handleSettings(twin);
                        */
                        //OK now we are connected
                        deviceConnected = true;

                        // sending data for the first time
                        node.log("sending data for the first time ...");
                        if(external_msg !== null && external_msg !== undefined) 
                            this.sendToCloud(external_msg);
                        else{ node.log("... but this.msg is null or undefined");}
                            }
                        });
              }
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
             //check if we need to send reported properties
             var reportedProps = msg.payload["reported.properties"];
             if(reportedProps){
                 node.log("Received reported properties");
                    //node.log(`sendToCloud : device twin: ${util.inspect(gTwin)}`);
                    if(gTwin !== null && gTwin !== undefined){
                        this.sendDeviceReportedProperties(reportedProps);
                    } else { node.log("Twin is null. We can not send Reported properties.")}
             }
             else{
                 node.log("received telemetry");
                 this.sendTelemetry(msg)
             }
        };
    }
    RED.nodes.registerType("Azure IoT Central",IoTCentralConfigNode);
}