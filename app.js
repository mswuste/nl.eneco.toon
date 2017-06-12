'use strict';

// TODO re-write pairing when OAuth2 pairing template becomes available
// TODO homey-log

const Homey = require('homey');
// const Log = require('homey-log').Log;

class ToonApp extends Homey.HomeyApp {
	onInit() {
		this.log(`${this.id} running...`);
	}
}

module.exports = ToonApp;