/* jshint node:true */
"use strict";

class SocketHub {
	constructor({ appName, server, tokenUtil, subdomainContent, storming, anonymousSuffix, rootHost }) {
		this.appName = appName;
		this.messages = {};
		this.sockets = [];
		this.socketAppCookieMap = {};
		this.socketIdMap = {};
		this.subdomainInfoMap = {};
		this.rootHost = rootHost;
		this.lazyNamer = require("lazy-namer");


		let socketio = require('socket.io');
		this.io = socketio.listen(server);
		this.async = require('async');
		this.cookie = require('cookie');
		this.tokenUtil = tokenUtil;
		this.subdomainContent = subdomainContent;

		this.backendLogs = {};

		this.anonymousSuffix = anonymousSuffix || '_?';
		this.anonymousNamesFromCookie = {};
		this.anonymousNamesInUse = {};

		this.backendBuilder = require('./backend-builder.js')({
			backendLogs: this.backendLogs,
			subdomainContent: this.subdomainContent,
			broadcast: this.broadcast,
			storming
		});
	}

	getAnonymousUserName(appCookie, callCount) {
		callCount = callCount || 1;
		if (!this.anonymousNamesFromCookie[appCookie]) {
			const anonymousName = `${this.lazyNamer.getName(2)}${this.anonymousSuffix}`;
			if (this.anonymousNamesInUse[anonymousName]) {
				if (callCount > 10) {
					return `${appCookie}${this.anonymousSuffix}`;
				}
				return this.getAnonymousUserName(appCookie, callCount++);
			}
			this.anonymousNamesFromCookie[appCookie] = anonymousName;
			this.anonymousNamesInUse[anonymousName] = true;
		}
		return this.anonymousNamesFromCookie[appCookie];
	}

	isAnonymousUserName(username) {
		return username.endsWith(this.anonymousSuffix);
	}

	logoutUserHook(req) {
		const appCookie = req.cookies[this.appName];
		if (appCookie && this.socketAppCookieMap[appCookie] !== undefined) {
			this.socketAppCookieMap[appCookie].forEach(socketId => {
				if (this.socketIdMap[socketId] != undefined) {
					const anonymousUserName = this.getAnonymousUserName(appCookie);
					const socket = this.socketIdMap[socketId];
					socket.loggedOut = true;
					socket.name = anonymousUserName;
					socket.emit('whoami', anonymousUserName);
					this.updateRoster(socket);
				}
			});
		}
	}


	loginUserHook(req, user, token) {
		const appCookie = req.cookies[this.appName];
		if (appCookie && this.socketAppCookieMap[appCookie] !== undefined) {
			this.socketAppCookieMap[appCookie].forEach(socketId => {
				if (this.socketIdMap[socketId] !== undefined) {
					const socket = this.socketIdMap[socketId];
					socket.name = user.username;
					socket.loggedOut = false;
					socket.token = token;
					socket.emit('whoami', user.username);
					this.updateRoster(socket);
				}
			});
		}
	}



	updateRoster(socket) {
		const foundNames = {};
		this.async.map(
			this.sockets.filter(s => s.subdomain === socket.subdomain),
			(socket, callback) => {
				foundNames[socket.name] = foundNames[socket.name] ? foundNames[socket.name] + 1 : 1;
				callback(null, (socket.myParent === undefined && (this.isAnonymousUserName(socket.name) || foundNames[socket.name] === 1)) ? socket.name : null);
			},
			(err, names) => {
				if (err) {
					console.error('updateRoster err', err);
				}
				this.broadcast('roster', names, socket.subdomain);
			}
		);
	}


	broadcast(event, data, subdomain) {
		this.sockets.filter(s => s.subdomain === subdomain).forEach((socket) => {
			socket.emit(event, data);
		});
	}


	init() {
		this.io.on('connection', async(socket) => {
			//
			//  Get appCookie (Unique per browser session);
			//
			socket.cookies = this.cookie.parse(socket.request.headers.cookie || '');
			const appCookie = socket.cookies[this.appName];


			//
			//  Create List of all sockets related to the curent user
			//
			if (this.socketAppCookieMap[appCookie] === undefined) {
				this.socketAppCookieMap[appCookie] = [];
			}
			this.socketAppCookieMap[appCookie].push(socket.id);


			//
			//  Socket caching (per tab)
			//
			this.socketIdMap[socket.id] = socket;
			this.sockets.push(socket);


			//
			//  Track life of socket.io cookies accross tabs
			//
			if (socket.cookies.io) {
				socket.myParent = this.socketIdMap[socket.cookies.io];
				if (socket.myParent) {
					socket.myParent.myChild = socket;
				}
			}


			//
			//  Get Subdomain
			//
			socket.subdomain = SocketHub.getSubdomain(socket.request.headers.host, this.rootHost);
			socket.subdomain = socket.subdomain === undefined ? '#' : socket.subdomain;
			await this.setSubdomainInfoMapAndMessages(socket.subdomain);


			// 
			//  Inform client of connection
			//
			socket.emit('connected', this.subdomainInfoMap[socket.subdomain]);


			//
			//  Send user info to client
			//

			(() => {
				this.setUserInfo(socket);
				this.updateRoster(socket);
				socket.emit('whoami', socket.name);
			})();



			//
			//  Emit all stored messages for subdomain to client
			//
			this.messages[socket.subdomain].forEach((data) => {
				socket.emit('message', data);
			});



			//
			//  Handle disconnect
			//
			socket.on('disconnect', () => {
				if (socket.myParent) {
					socket.myParent.myChild = undefined;
				}
				if (socket.myChild) {
					socket.myChild.myParent = undefined;
				}
				this.socketAppCookieMap[appCookie].splice(this.socketAppCookieMap[appCookie].indexOf(socket.id), 1);
				this.socketIdMap[socket.id] = undefined;
				this.sockets.splice(this.sockets.indexOf(socket), 1);
				this.updateRoster(socket);

				const backend = this.backendBuilder.fetchFromCache(socket.subdomain);
				if (backend && backend.disconnectSocket) {
					backend.disconnectSocket({ appCookie: appCookie, socketId: socket.id });
				}
			});


			//
			//  built-in utils
			//
			this.builtInOnMessage(socket);
			this.builtInOnCommand(socket);


			try {
				const backend = await this.backendBuilder.build(socket.subdomain, true);
				const socketIOHooks = backend.getSocketIOHooks({ log: (...args) => socket.emit('debug', args) });
				socketIOHooks.forEach((socketIOHook) => {
					socket.on(socketIOHook.on, (dataIn) => {
						try {
							socketIOHook.run({
								emit: (message, data) => socket.emit(message, data),
								dataIn,
								socketId: socket.id,
								user: {
									username: socket.name,
									isAnonymous: this.isAnonymousUserName(socket.name),
									sessionId: appCookie
								}
							});
						}
						catch (err) {
							console.info('Error registering code hook: ', socketIOHook, err);
							socket.emit('debug', { socketIOHook, message: err && err.message ? err.message : err });
						}
					});
				});
			}
			catch (err) {
				console.error('Issue setting up backend' + err);
			}

		});
	}


	clearFromSubdomainInfoMap(subdomain) {
		this.subdomainInfoMap[subdomain] = undefined;
	}
	setSubdomainInfoMapAndMessages(subdomain) {
		return new Promise(async(resolve, reject) => {
			subdomain = subdomain === undefined ? '#' : subdomain;

			if (!this.subdomainInfoMap[subdomain]) {
				this.subdomainInfoMap[subdomain] = await this.subdomainContent.getInfo(subdomain);
			}
			if (this.messages[subdomain] === undefined) {
				this.messages[subdomain] = [];
			}
			resolve(true);
		});
	}



	setUserInfo(socket) {
		if (socket.loggedOut) {
			socket.name = this.getAnonymousUserName(socket.cookies[this.appName]);
		}
		else {
			let token = socket.token ? socket.token : this.tokenUtil.getTokenFromCookies(socket.cookies);
			let user = token ? this.tokenUtil.verifyToken(token) : null;
			socket.name = String((user ? user.username : null) || this.getAnonymousUserName(socket.cookies[this.appName]));
			if (!user) {
				this.updateRoster(socket);
			}
		}
	}

	builtInOnMessage(socket) {
		socket.on('message', (msg) => {
			this.setUserInfo(socket);
			let text = String(msg || '');

			if (!text)
				return;

			let data = {
				name: socket.name,
				text: text
			};

			this.broadcast('message', data, socket.subdomain);
			this.messages[socket.subdomain].push(data);
		});
	}


	startGameLoop(subdomain, tag) {
		this.backendBuilder.startGameLoop(subdomain, tag);
	}


	stopGameLoop(subdomain, tag) {
		this.backendBuilder.stopGameLoop(subdomain, tag);
	}

	builtInOnCommand(socket) {

		socket.on('command', (msg) => {
			this.setUserInfo(socket);
			let text = String(msg || '');

			if (!text) {
				socket.emit('debug', 'missing command');
				return;
			}

			if (msg.name === undefined) {
				socket.emit('debug', 'missing command name');
				return;
			}

			const isOwner = socket.name === this.subdomainInfoMap[socket.subdomain].owner || socket.name === 'admin';

			if (!isOwner) {
				return;
			}

			console.log('command', msg);
			if (isOwner && msg.name === 'refresh-backend') {
				//TODO: Make this code more robust (reset active socketio sessions, cleanup old gameloops, etc.)
				console.log(`[${socket.subdomain}] - REFRESH`);
				this.backendBuilder.build(socket.subdomain, false);
				socket.emit('debug', 'backend refreshed');
			}
			else if (isOwner && msg.name === 'start-game-loop') {
				console.log(`[${socket.subdomain}] - START-GAME-LOOP`, msg.tag);
				socket.emit('debug', this.startGameLoop(socket.subdomain, msg.tag));
			}
			else if (isOwner && msg.name === 'stop-game-loop') {
				console.log(`[${socket.subdomain}] - STOP-GAME-LOOP`, msg.tag);
				socket.emit('debug', this.stopGameLoop(socket.subdomain, msg.tag));
			}
			else if (isOwner && msg.name === 'game-logs') {
				console.log(`[${socket.subdomain}] - GAME LOGS`, msg.tag);
				if (!this.backendLogs || !this.backendLogs[socket.subdomain]) {
					socket.emit('debug', 'no logs found');
				}
				else {
					socket.emit('debug', this.backendLogs[socket.subdomain]);
				}
			}
		});
	}
}

SocketHub.getSubdomain = (host, rootHost) => {
	if(!rootHost) {
		if(host.indexOf(".") > -1) {
			return host.substring(0, host.indexOf('.'));
		}
		return;
	}
	host = host.indexOf(':') > -1 ? host.substring(0, host.indexOf(':')) : host;
	let subdomain;
	if (rootHost !== host && host.endsWith("." + rootHost)) {
		subdomain = host.substring(0, host.indexOf("." + rootHost));
	}
	return subdomain;
};

module.exports = SocketHub;
