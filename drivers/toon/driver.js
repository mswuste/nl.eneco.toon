'use strict';

const Homey = require('homey');

const ToonDevice = require('./device.js');
const ToonAPI = require('./../../lib/node-toon');

const OAUTH_URL = `https://api.toonapi.com/authorize?response_type=code&client_id=${Homey.env.TOON_KEY}&redirect_uri=https://callback.athom.com/oauth2/callback/`;

class ToonDriver extends Homey.HomeyDriver {

	/**
	 * This method will be called when the driver initializes, it initializes Flow Cards.
	 */
	onInit() {
		new Homey.HomeyFlowCardCondition('temperature_state_is')
			.on('run', (args, state, callback) => {
				const temperatureState = args.device.getCapabilityValue('temperature_state');
				return callback(null, temperatureState === args.state);
			})
			.register();

		new Homey.HomeyFlowCardAction('set_temperature_state')
			.on('run', (args, state, callback) =>
				args.device.onCapabilityTemperatureState(args.state, (args.resume_program === 'yes'))
					.then(() => callback(null, true))
					.catch(err => callback(err)))
			.register();

		new Homey.HomeyFlowCardAction('enable_program')
			.on('run', (args, state, callback) => args.device.toonAPI.enableProgram()
				.then(() => callback(null, true))
				.catch(err => callback(err)))
			.register();

		new Homey.HomeyFlowCardAction('disable_program')
			.on('run', (args, state, callback) => args.device.toonAPI.disableProgram()
				.then(() => callback(null, true))
				.catch(err => callback(err)))
			.register();

		this.log('onInit() -> complete, Flow Cards registered');
	}

	/**
	 * This method will be called when the user starts pairing a new device,
	 * it executes a OAuth2 flow to retrieve devices linked to the users account.
	 * @param socket
	 */
	onPair(socket) {

		const authenticationClientToonAPI = new ToonAPI({ key: Homey.env.TOON_KEY, secret: Homey.env.TOON_SECRET });

		socket.on('authentication', () => {
			new Homey.HomeyCloudOAuth2Callback(OAUTH_URL)
				.once('url', url => {
					this.log('retrieved authentication url:', url);
					socket.emit('authenticationUrl', url);
				})
				.once('code', code => {
					this.log('retrieved authentication code');
					authenticationClientToonAPI
						.getAccessTokens(code, 'https://callback.athom.com/oauth2/callback/')
						.then(() => {
							socket.emit('authenticated', true);
						})
						.catch(err => {
							this.error(err.stack);
							socket.emit('authenticated', err.message);
						});
				})
				.generate()
				.catch(this.error.bind(this, 'oauth2Callback.generate'));
		});

		socket.on('list_devices', (data, callback) => {
			this.fetchDevices(authenticationClientToonAPI)
				.then(tempDevices => callback(null, tempDevices))
				.then(authenticationClientToonAPI.destroy.bind(authenticationClientToonAPI))
				.catch(err => {
					this.error(err.stack);
					return callback(err.message);
				});
		});
	}

	/**
	 * Always use ToonDevice as device for this driver.
	 * @returns {ToonDevice}
	 */
	mapDeviceClass() {
		return ToonDevice;
	}

	/**
	 * This method will be called during pairing to retrieve a list of devices
	 * connected to the user's account.
	 * @param authenticationClientToonAPI
	 * @returns {Promise}
	 */
	fetchDevices(authenticationClientToonAPI) {
		return authenticationClientToonAPI.getAgreements().then(agreements => {
			if (Array.isArray(agreements)) {
				return agreements.map(agreement => {

					// Store access token in settings
					Homey.HomeyManagerSettings.set(`toon_${agreement.displayCommonName}_access_token`, authenticationClientToonAPI.accessToken);
					Homey.HomeyManagerSettings.set(`toon_${agreement.displayCommonName}_refresh_token`, authenticationClientToonAPI.refreshToken);

					return {
						name: (agreements.length > 1) ? `Toon®: ${agreement.street} 
												${agreement.houseNumber} , ${agreement.postalCode} 
												${agreement.city.charAt(0)}${agreement.city.slice(1).toLowerCase()}` : 'Toon®',
						data: {
							id: agreement.displayCommonName,
							agreementId: agreement.agreementId,
						},
					};
				});
			}
			return [];
		});
	}
}

module.exports = ToonDriver;
