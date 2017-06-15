'use strict';

class PromiseQueue {

	constructor(options) {
		options = options || {};
		this._concurrency = options.concurrency || 1;
		this._queue = [];
	}

	get size() {
		console.log('size()', this._queue.length);
		return this._queue.length;
	}

	add(fn) {
		console.log('add() -> current queue size:', this.size);
		return new Promise((resolve, reject) => {

			const execute = (override) => {
				if (override) {
					console.log('execute with OVERRIDE');
					return reject(override);
				}
				fn()
					.then(result => {
						this.remove(execute);
						this._next();
						return resolve(result);
					})
					.catch(err => {
						this.remove(execute);
						this._next();
						return reject(err);
					});
			};

			if (this.size < this._concurrency) {
				console.log('execute');
				this._queue.push(execute);
				execute();
			} else {
				console.log('queue');
				this._queue.push(execute);
			}
		});
	}

	remove(fn) {
		console.log('remove()');
		this._queue = this._queue.filter(promise => promise !== fn);
	}

	abort() {
		this._queue.forEach(fn => {
			console.log('abort');
			fn('aborted');
			this.remove(fn);
		});
	}

	_next() {
		console.log('next() ->', this._queue);
		const execute = this._queue.pop();
		if (typeof execute !== 'undefined') {
			console.log(execute);
			execute.call(this);
		}
	}
}

// const pq = new PromiseQueue();
// pq.add(() => new Promise((resolve, reject) => {
// 	console.log('start promise 1');
// 	setTimeout(() => {
// 		return resolve('promise1');
// 	}, 2000);
// })).then(result => {
// 		console.log('promise1 -> resolved', result)
// }).catch(err => {
// 		console.log('promise1 -> rejected', err)
// 	console.error(err);
// });
// pq.add(() => new Promise((resolve, reject) => {
// 	console.log('start promise 2');
// 	setTimeout(() => {
// 		return resolve('promise2');
// 	}, 2000);
// })).then(result => {
// 		console.log('promise2 -> resolved', result)
// }).catch(err => {
// 		console.log('promise2 -> rejected', err)
// 	console.error(err);
// });
// pq.abort();

module.exports = PromiseQueue;
