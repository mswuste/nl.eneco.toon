var _ = require( 'underscore' );
var Toon = require( 'toonapp' );
var devices = [];
var temp_devices = [];
var toon;
/***
 * Find Toon
 * @param devices (already installed)
 * @param callback
 */
module.exports.init = function ( devices_data, callback ) {

    toon = new Toon( {
        username: Homey.settings.toon_username,
        password: Homey.settings.password
    } );

    toon.getState( function ( err, data ) {
        if ( err ) {
            return callback( err, data );
        }
        if ( data.randomConfigId ) {
            // Check if device was installed before
            var devices = (_.findWhere( devices_data, { id: data.randomConfigId } )) ? devices : temp_devices;

            // Add them to create devices array
            devices.push( {
                data: {
                    id: data.randomConfigId
                },
                name: 'Toon'
            } );
        }
    } );

    // Ready
    callback( true );
};

/**
 * Pairing process that calls list_devices when in need of all available Toon devices,
 * here the devices array is built and send to the front-end
 */
module.exports.pair = {

    /**
     * Constructs array of all available devices
     */
    list_devices: function ( callback ) {

        var devices = [];
        temp_devices.forEach( function ( temp_device ) {
            devices.push( {
                data: {
                    id: temp_device.data.id
                },
                name: temp_device.name
            } );
        } );

        callback( devices );
    },

    add_device: function ( callback, emit, device ) {

        temp_devices.forEach( function ( temp_device ) {
            if ( temp_device.data.id === device.data.id ) {
                devices.push( {
                    data: {
                        id: temp_device.data.id
                    },
                    name: temp_device.name
                } );
            }
        } );
    }

};

/**
 * These represent the capabilities of Toon
 */
module.exports.capabilities = {

    target_temperature: {
        get: function ( device_data, callback ) {
            toon.getState( function ( err, data ) {
                if ( err ) {
                    return callback( err, data );
                }
                if ( data.currentSetpoint ) {
                    //TODO parse temperature from 1944 to 19,4444343
                    callback( err, data.currentSetpoint.value );
                }
            } );
        },
        set: function ( device_data, temperature, callback ) {
            //TODO parse temperature from 19,4444343 to 1944
            toon.setTemperature( 1944, function ( err, data ) {
                if ( !err ) {
                    callback( err, temperature );
                }
            } );
        }
    },

    measure_temperature: {
        get: function ( device_data, callback ) {
            toon.getState( function ( err, data ) {
                if ( err ) {
                    return callback( err, data );
                }
                if ( data.currentTemp ) {
                    //TODO parse temperature from 1944 to 19,4444343
                    callback( err, data.currentTemp.value );
                }
            } );
        }
    }
};

function getDevice ( device_id ) {
    var found_device = null;
    devices.forEach( function ( device ) {
        if ( device.data.id === device_id ) {
            found_device = device;
        }
    } );
    return found_device;
}