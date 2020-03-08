const request = require('request');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const parseXMLString = require('xml2js').parseString;

let Service, Characteristic;

module.exports = homebridge => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform('homebridge-denon-tv', 'DenonTv', denonTvPlatform);
};

class denonTvPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    this.devices = config.devices || [];
    this.tvAccessories = [];

    if (this.version < 2.1) {
      throw new Error('Unexpected API version.');
    }
  }

  accessories(callback) {
    for (let i in this.devices) {
      this.tvAccessories.push(new denonTvDevice(this.log, this.devices[i], this.api));
    }

    callback(this.tvAccessories);
  }
}

class denonTvDevice {
  constructor(log, device, api) {
    this.log = log;
    this.api = api;
    this.services = [];

    // device configuration
    this.device = device;
    this.name = device.name;
    this.host = device.host;
    this.port = device.port || 8080;
    this.url = ('http://' + this.host + ':' + this.port);
    this.switchInfoMenu = device.switchInfoMenu;
    this.inputs = device.inputs;

    // setup variables
    this.connectionStatus = false;
    this.inputReferences = [];
    this.currentPowerState = false;
    this.currentMuteState = false;
    this.currentVolume = 0;
    this.currentInputReference = null;
    this.currentInfoMenuState = false;
    this.prefDir = path.join(this.api.user.storagePath(), "denonTv");
    this.hasSetInfo = false;

    this.inputsFile = path.join(this.prefDir, 'inputs_' + this.host.split('.').join('') + '.json');
    this.devInfoFile = path.join(this.prefDir, 'info_' + this.host.split('.').join('') + '.json');

    // get Device info
    this.manufacturer = device.manufacturer || 'Denon/Marantz';
    this.modelName = device.modelName || 'homebridge-denon-tv';
    this.serialNumber = device.serialNumber || 'SN000002';
    this.firmwareRevision = device.firmwareRevision || 'FW000002';

    // check if the directory exists, if not then create it
    if (fs.existsSync(this.prefDir) === false) {
      mkdirp(this.prefDir);
    }

    this.getDeviceStatus();

    // Check net state
    setInterval(this.getDeviceStatus.bind(this), 5000);
  }

  getDeviceStatus() {
    const me = this;

    request('http://' + me.host + ':60006/upnp/desc/aios_device/aios_device.xml', function (error, response) {
      if (error) {
        me.log('Device: %s, name: %s, state: Offline', me.host, me.name);
        me.log.debug(error);
        me.connectionStatus = false;
      } else if (!me.connectionStatus) {
        me.log('Device: %s, name: %s, state: Online', me.host, me.name);
        me.connectionStatus = true;

        if (!me.hasSetInfo) {
          response = response.replace(/:/g, '');
          parseXMLString(response, function (error, result) {
            if (error) {
              me.log.debug('Device %s, getDeviceStatus parse string error: %s', me.host, error);
              return;
            } else {
              me.manufacturer = result.root.device[0].manufacturer[0];
              me.modelName = result.root.device[0].modelName[0];
              me.serialNumber = result.root.device[0].serialNumber[0];

              if (result.root.device[0].deviceList[0].device) {
                result.root.device[0].deviceList[0].device.forEach(function (device) {
                  if (device.firmwareRevision !== undefined) {
                    me.firmwareRevision = device.firmwareRevision;
                    return;
                  }
                });
              }

              me.log('-------- %s --------', me.name);
              me.log('Manufacturer: %s', me.manufacturer);
              me.log('Model: %s', me.modelName);
              me.log('Serialnumber: %s', me.serialNumber);
              me.log('Firmware: %s', me.firmwareRevision);
              me.log('----------------------------------');

              me.hasSetInfo = true;
            }
          });
        }
      }
    });
  }

  // Prepare TV service
  getServices() {
    this.log.debug('getServices');

    // Info service
    this.informationService = new Service.AccessoryInformation();
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(Characteristic.Model, this.modelName)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);

    this.services.push(this.informationService);

    // Tv Service
    this.tvService = new Service.Television(this.name, 'tvService');
    this.tvService.setCharacteristic(Characteristic.ConfiguredName, this.name);
    this.tvService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    this.tvService.getCharacteristic(Characteristic.Active)
      .on('get', this.getPowerState.bind(this))
      .on('set', this.setPowerState.bind(this));

    this.tvService.getCharacteristic(Characteristic.ActiveIdentifier)
      .on('get', this.getInput.bind(this))
      .on('set', (inputIdentifier, callback) => {
        this.setInput(callback, this.inputReferences[inputIdentifier]);
      });

    this.tvService.getCharacteristic(Characteristic.RemoteKey)
      .on('set', this.remoteKeyPress.bind(this));

    this.tvService.getCharacteristic(Characteristic.PowerModeSelection)
      .on('set', this.setPowerModeSelection.bind(this));

    this.services.push(this.tvService);

    // Speakers and Inputs
    this.prepareTvSpeakerService();
    this.prepareInputServices();

    this.log.debug('Device: %s, getServices: %s', this.host, this.name);

    return this.services;
  }

  // Prepare speaker service
  prepareTvSpeakerService() {
    this.log.debug('prepareTvSpeakerService');
    this.tvSpeakerService = new Service.TelevisionSpeaker(this.name, 'tvSpeakerService');
    this.tvSpeakerService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
    this.tvSpeakerService.getCharacteristic(Characteristic.VolumeSelector)
      .on('set', this.volumeSelectorPress.bind(this));
    this.tvSpeakerService.getCharacteristic(Characteristic.Volume)
      .on('get', this.getVolume.bind(this))
      .on('set', this.setVolume.bind(this));
    this.tvSpeakerService.getCharacteristic(Characteristic.Mute)
      .on('get', this.getMute.bind(this))
      .on('set', this.setMute.bind(this));

    // this.tvService.addLinkedService(this.tvSpeakerService);
    this.services.push(this.tvSpeakerService);
  }

  // Prepare inputs services
  prepareInputServices() {
    this.log.debug('prepareInputServices');
    if (this.inputs === undefined || this.inputs === null || this.inputs.length <= 0) {
      return;
    }

    if (Array.isArray(this.inputs) === false) {
      this.inputs = [this.inputs];
    }

    let savedNames = {};
    try {
      savedNames = JSON.parse(fs.readFileSync(this.inputsFile));
    } catch (err) {
      this.log.debug('Device: %s, inputs file %s does not exist', this.host, this.inputsFile);
    }

    this.inputs.forEach((input, i) => {
      // get input reference
      let inputReference = null;

      if (input.reference !== undefined) {
        inputReference = input.reference;
      } else {
        inputReference = input;
      }

      // get input name
      let inputName = inputReference;

      if (savedNames && savedNames[inputReference]) {
        inputName = savedNames[inputReference];
      } else if (input.name) {
        inputName = input.name;
      }

      // if reference not null or empty add the input
      if (inputReference !== undefined && inputReference !== null && inputReference !== '') {
        inputReference = inputReference.replace(/\s/g, ''); // remove all white spaces from the string

        let tempInput = new Service.InputSource(inputReference, 'input' + i);
        tempInput
          .setCharacteristic(Characteristic.Identifier, i)
          .setCharacteristic(Characteristic.ConfiguredName, inputName)
          .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
          .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.TV)
          .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);

        tempInput
          .getCharacteristic(Characteristic.ConfiguredName)
          .on('set', (name, callback) => {
            this.inputs[inputReference] = name;
            fs.writeFile(this.inputsFile, JSON.stringify(this.inputs), (error) => {
              if (error) {
                this.log.debug('Device: %s, can not write new Input name, error: %s', this.host, error);
              } else {
                this.log('Device: %s, saved new Input successfull, name: %s reference: %s', this.host, name, inputReference);
              }
            });
            callback();
          });

        this.inputReferences.push(inputReference);
        this.services.push(tempInput);
        this.tvService.addLinkedService(tempInput);
      }

    });
  }

  getPowerState(callback) {
    const me = this;
    request(me.url + '/goform/formMainZone_MainZoneXmlStatusLite.xml', function (error, response, data) {
      if (error) {
        me.log.debug('Device: %s, can not get current Power state. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        parseXMLString(data, function (error, result) {
          if (error) {
            me.log.debug('Device %s, getPowerState parse string error: %s', me.host, error);
            callback(error);
          } else {
            const state = (result.item.Power[0].value[0] == 'ON');
            me.log('Device: %s, get current Power state successfull: %s', me.host, state ? 'ON' : 'STANDBY');
            me.currentPowerState = state;
            callback(null, state);
          }
        });
      }
    });
  }

  setPowerState(state, callback) {
    const me = this;
    me.getPowerState(function (error, currentPowerState) {
      if (error) {
        me.log.debug('Device: %s, can not get current Power state. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        if (state !== currentPowerState) {
          const newState = state ? 'ON' : 'STANDBY';
          request(me.url + '/goform/formiPhoneAppDirect.xml?PW' + newState, function (error) {
            if (error) {
              me.log.debug('Device: %s, can not set new Power state. Might be due to a wrong settings in config, error: %s', me.host, error);
              callback(error);
            } else {
              me.log('Device: %s, set new Power state successfull: %s', me.host, state ? 'ON' : 'STANDBY');
              me.currentPowerState = state;
              callback(null, state);
            }
          });
        }
      }
    });
  }

  getMute(callback) {
    const me = this;
    request(me.url + '/goform/formMainZone_MainZoneXmlStatusLite.xml', function (error, response, data) {
      if (error) {
        me.log.debug('Device: %s, can not get current Mute state. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        parseXMLString(data, function (error, result) {
          if (error) {
            me.log.debug('Device %s, getMute parse string error: %s', me.host, error);
            callback(error);
          } else {
            const state = (result.item.Mute[0].value[0] == 'ON');
            me.log('Device: %s, get current Mute state successfull: %s', me.host, state ? 'ON' : 'OFF');
            me.currentMuteState = state;
            callback(null, state);
          }
        });
      }
    });
  }

  setMute(state, callback) {
    const me = this;
    me.getMute(function (error, currentMuteState) {
      if (error) {
        me.log.debug('Device: %s, can not get current Mute for new state. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        if (state !== currentMuteState) {
          const newState = state ? 'ON' : 'OFF';
          request(me.url + '/goform/formiPhoneAppDirect.xml?MU' + newState, function (error) {
            if (error) {
              me.log.debug('Device: %s, can not set new Mute state. Might be due to a wrong settings in config, error: %s', me.host, error);
              callback(error);
            } else {
              me.log('Device: %s, set new Mute state successfull: %s', me.host, state ? 'ON' : 'OFF');
              me.currentMuteState = state;
              callback(null, state);
            }
          });
        }
      }
    });
  }

  getVolume(callback) {
    const me = this;
    request(me.url + '/goform/formMainZone_MainZoneXmlStatusLite.xml', function (error, response, data) {
      if (error) {
        me.log.debug('Device: %s, can not get current Volume level. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        parseXMLString(data, function (error, result) {
          if (error) {
            me.log.debug('Device %s, getVolume parse string error: %s', me.host, error);
            callback(error);
          } else {
            const volume = parseInt(result.item.MasterVolume[0].value[0]) + 80;
            me.log('Device: %s, get current Volume level successfull: %s', me.host, volume);
            me.currentVolume = volume;
            callback(null, me.currentVolume);
          }
        });
      }
    });
  }

  setVolume(volume, callback) {
    const me = this;
    const targetVolume = (volume - 2).toString();

    request(me.url + '/goform/formiPhoneAppDirect.xml?MV' + targetVolume, function (error) {
      if (error) {
        me.log.debug('Device: %s, can not set new Volume level. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        me.log('Device: %s, set new Volume level successfull: %s', me.host, targetVolume);
        callback(null, volume);
      }
    });
  }

  getInput(callback) {
    const me = this;
    request(me.url + '/goform/formMainZone_MainZoneXmlStatusLite.xml', function (error, response, data) {
      if (error) {
        me.log.debug('Device: %s, can not get current Input. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        parseXMLString(data, function (error, result) {
          if (error) {
            me.log.debug('Device %s, getInput parse string error: %s', me.host, error);
            callback(error);
          } else {
            const inputReference = result.item.InputFuncSelect[0].value[0];
            if (!me.connectionStatus || (inputReference === undefined || inputReference === null || inputReference === '')) {
              me.tvService
                .getCharacteristic(Characteristic.ActiveIdentifier)
                .updateValue(0);
              callback(null, inputReference);
            } else {
              for (let i = 0; i < me.inputReferences.length; i++) {
                if (inputReference === me.inputReferences[i]) {
                  me.tvService
                    .getCharacteristic(Characteristic.ActiveIdentifier)
                    .updateValue(i);
                  me.log('Device: %s, get current Input successfull: %s', me.host, inputReference);
                  me.currentInputReference = inputReference;
                  callback(null, inputReference);
                }
              }
            }
          }
        });
      }
    });
  }

  setInput(callback, inputReference) {
    const me = this;

    me.getInput(function (error, currentInputReference) {
      if (error) {
        me.log.debug('Device: %s, can not get current Input. Might be due to a wrong settings in config, error: %s', me.host, error);

        callback(error);
      } else {
        if (inputReference !== currentInputReference) {
          request(me.url + '/goform/formiPhoneAppDirect.xml?SI' + inputReference, function (error) {
            if (error) {
              me.log.debug('Device: %s, can not set new Input. Might be due to a wrong settings in config, error: %s', me.host, error);
              callback(error);
            } else {
              me.log('Device: %s, set new Input successfull: %s', me.host, inputReference);
              me.currentInputReference = inputReference;

              callback(null, inputReference);
            }
          });
        }
      }
    });
  }

  setPowerModeSelection(state, callback) {
    const me = this;
    let command = me.switchInfoMenu ? 'MNMEN ON' : 'MNINF';

    if (me.currentInfoMenuState) {
      command = 'MNRTN';
    }

    request(me.url + '/goform/formiPhoneAppDirect.xml?' + command, function (error) {
      if (error) {
        me.log.debug('Device: %s, can not set power mode selection. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        me.log('Device: %s, setPowerModeSelection successfull, state: %s, command: %s', me.host, me.currentInfoMenuState ? 'HIDDEN' : 'SHOW', command);
        me.currentInfoMenuState = !me.currentInfoMenuState;
        callback(null, state);
      }
    });
  }

  volumeSelectorPress(remoteKey, callback) {
    const me = this;
    let command = '';

    switch (remoteKey) {
      case Characteristic.VolumeSelector.INCREMENT:
        command = 'MVUP';
        break;
      case Characteristic.VolumeSelector.DECREMENT:
        command = 'MVDOWN';
        break;
    }

    request(me.url + '/goform/formiPhoneAppDirect.xml?' + command, function (error) {
      if (error) {
        me.log.debug('Device: %s, can not send power key command. Might be due to a wrong settings in config, error: %s', me.host, error);
        callback(error);
      } else {
        me.log('Device: %s, key prssed: %s, command: %s', me.host, remoteKey, command);
        callback(null, remoteKey);
      }
    });
  }

  remoteKeyPress(remoteKey, callback) {
    const me = this;
    let command = '';

    switch (remoteKey) {
      case Characteristic.RemoteKey.REWIND:
        command = 'MN9E';
        break;
      case Characteristic.RemoteKey.FAST_FORWARD:
        command = 'MN9D';
        break;
      case Characteristic.RemoteKey.NEXT_TRACK:
        command = 'MN9F';
        break;
      case Characteristic.RemoteKey.PREVIOUS_TRACK:
        command = 'MN9G';
        break;
      case Characteristic.RemoteKey.ARROW_UP:
        command = 'MNCUP';
        break;
      case Characteristic.RemoteKey.ARROW_DOWN:
        command = 'MNCDN';
        break;
      case Characteristic.RemoteKey.ARROW_LEFT:
        command = 'MNCLT';
        break;
      case Characteristic.RemoteKey.ARROW_RIGHT:
        command = 'MNCRT';
        break;
      case Characteristic.RemoteKey.SELECT:
        command = 'MNENT';
        break;
      case Characteristic.RemoteKey.BACK:
        command = 'MNRTN';
        break;
      case Characteristic.RemoteKey.EXIT:
        command = 'MNRTN';
        break;
      case Characteristic.RemoteKey.PLAY_PAUSE:
        command = 'NS94';
        break;
      case Characteristic.RemoteKey.INFORMATION:
        command = me.switchInfoMenu ? 'MNINF' : 'MNMEN ON';
        break;
    }


    request(me.url + '/goform/formiPhoneAppDirect.xml?' + command, function (error) {
      if (error) {
        me.log.debug('Device: %s, can not send key command: %s. Might be due to a wrong settings in config, error: %s', me.host, command, error);
        callback(error);
      } else {
        me.log('Device: %s, key prssed: %s, command: %s', me.host, remoteKey, command);
        callback(null, remoteKey);
      }
    });
  }
}
