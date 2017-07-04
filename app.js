'use strict';

const Homey = require('homey');
const Log = require('homey-log').Log;

class ToonApp extends Homey.App {
	onInit() {
		this.log(`${this.id} running...`);
	}
}

module.exports = ToonApp;
