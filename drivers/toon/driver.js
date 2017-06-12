'use strict';

const Homey = require('homey');

const ToonDevice = require('./device.js');
const ToonAPI = require('./../../lib/node-toon');

const OAUTH_URL = `https://api.toonapi.com/authorize?response_type=code&client_id=${Homey.env.TOON_KEY}&redirect_uri=https://callback.athom.com/oauth2/callback/`;

class ToonDriver extends Homey.HomeyDriver {

	/**
	 * Always use ToonDevice as device for this driver.
	 * @returns {ToonDevice}
	 */
	mapDeviceClass() {
		return ToonDevice;
	}

	/**
	 * This method will be called when the driver initializes, it creates
	 * instances enabling the OAuth2 flow and initializes Flow Cards.
	 */
	onInit() {
		this.authenticationClientToonAPI = new ToonAPI({ key: Homey.env.TOON_KEY, secret: Homey.env.TOON_SECRET });
		this.oauth2Callback = new Homey.HomeyCloudOAuth2Callback(OAUTH_URL);
		this.initFlowCards();
	}

	/**
	 * This method will be called when the user starts pairing a new device,
	 * it executes a OAuth2 flow to retrieve devices linked to the users account.
	 * @param socket
	 */
	onPair(socket) {

		socket.on('authentication', (data, callback) => {
			this.oauth2Callback
				.once('url', url => {
					this.log('retrieved authentication url:', url);
					socket.emit('authenticationUrl', url);
				})
				.once('code', code => {
					this.log('retrieved authentication code');
					this.authenticationClientToonAPI
						.getAccessTokens(code, 'https://callback.athom.com/oauth2/callback/')
						.then(() => {
							socket.emit('authenticated', true);
						})
						.catch(err => {
							this.error(err.stack);
							socket.emit('authenticated', err.message);
						})
				})
				.generate()
				.catch(this.error.bind(this, 'oauth2Callback.generate'))
		});

		socket.on('list_devices', (data, callback) => {
			this.fetchDevices()
				.then(tempDevices => callback(null, tempDevices))
				.catch(err => callback(err.message));
		});
	}

	/**
	 * This method will be called upon driver initialization and will
	 * register Flow Cards for this driver.
	 */
	initFlowCards() {
		new Homey.HomeyFlowCardCondition('temperature_state_is')
			.on('run', (args, state, callback) => {
				const temperatureState = args.device.getCapabilityValue('temperature_state');
				return callback(null, temperatureState === args.state);
			})
			.register();

		new Homey.HomeyFlowCardAction('set_temperature_state')
			.on('run', (args, state, callback) => {
				return args.device.onCapabilityTemperatureState(args.state, (args.resume_program === 'yes'))
					.then(result => callback(null, true))
					.catch(err => callback(err));
			})
			.register();

		new Homey.HomeyFlowCardAction('enable_program')
			.on('run', (args, state, callback) => {
				return args.device.toonAPI.enableProgram()
					.then(result => callback(null, true))
					.catch(err => callback(err));
			})
			.register();

		new Homey.HomeyFlowCardAction('disable_program')
			.on('run', (args, state, callback) => {
				return args.device.toonAPI.disableProgram()
					.then(result => callback(null, true))
					.catch(err => callback(err));
			})
			.register();
	}

	/**
	 * This method will be called during pairing to retrieve a list of devices
	 * connected to the user's account.
	 * @returns {Promise}
	 */
	fetchDevices() {
		return this.authenticationClientToonAPI.getAgreements().then(agreements => {
			if (Array.isArray(agreements)) {
				return agreements.map(agreement => {

					// Store access token in settings
					Homey.HomeyManagerSettings.set(`toon_${agreement.displayCommonName}_access_token`, this.authenticationClientToonAPI.accessToken);
					Homey.HomeyManagerSettings.set(`toon_${agreement.displayCommonName}_refresh_token`, this.authenticationClientToonAPI.refreshToken);

					return {
						name: (agreements.length > 1) ? `Toon®: ${agreement.street} 
												${agreement.houseNumber} , ${agreement.postalCode} 
												${agreement.city.charAt(0)}${agreement.city.slice(1).toLowerCase()}` : 'Toon®',
						data: {
							id: agreement.displayCommonName,
							agreementId: agreement.agreementId
						}
					};
				});
			}
			return [];
		});
	}
}

module.exports = ToonDriver;