class BackendBuilder {
	constructor({ backendLogs, subdomainContent, broadcast, storming }) {
			this.backendLogs = backendLogs;
			this.subdomainContent = subdomainContent || {
				getStorming: null,
				getInfo: (subdomain) => ({subdomain})
			};
			this.broadcast = broadcast;
			
			this.gameloop = require('node-gameloop');
			
			this.cachedBackends = {};
			this.subdomainCaches = {};
			this.cachedGameLoops = {};
			this.storming = storming;
	}
	
	fetchFromCache(subdomain) {
		return this.cachedBackends[subdomain];
	}
	
	build(subdomain, useCache = true) {
		return new Promise(async (resolve, reject) => {
			
			let backend = false;
			
			if (useCache && this.cachedBackends[subdomain]) {
				//console.info(subdomain, `[${subdomain}] - Getting cached backend`);
				backend = this.cachedBackends[subdomain];
				
				//let objectSizeof = require("object-sizeof");
				//console.info('BACKEND SIZE: ', objectSizeof(backend));
			}
			
			
			if (this.subdomainCaches[subdomain] === undefined) {
				this.subdomainCaches[subdomain] = {};
			}
			
			if(!backend) {
				console.info(`[${subdomain}] - Loading backend`);
				
				let storming;
				
				if(this.subdomainContent.getStorming) {
					storming = await this.subdomainContent.getStorming(subdomain);
				} else {
					storming = this.storming;
				}
				
				const dataSourcesAndServices = {
					subdomain: subdomain,
					broadcast: (data) => this.broadcast('message', data, subdomain),
					cache: this.subdomainCaches[subdomain],
					gameloop: {
						start: (tag) => {
							this.startGameLoop(subdomain, tag);
						},
						stop: (tag) => {
							this.stopGameLoop(subdomain, tag);
						}
					},
					storming: storming,
					console: { log: (args) => {
						this.backendLogs[subdomain].splice(0,0, args);
						this.backendLogs[subdomain] = this.backendLogs[subdomain].slice(0,1000);
					}}
				};
				
				
				// Register common and backend code
                dataSourcesAndServices.common = await this.subdomainContent.getExports(subdomain, 'common');
				
				if(!this.backendLogs[subdomain]) {
					this.backendLogs[subdomain] = [];
				}
				const Backend = await this.subdomainContent.getExports(subdomain, 'backend');
				backend = new Backend(dataSourcesAndServices);
				
				console.log(`[${subdomain}] - Back-end loaded`);
				
				this.cachedBackends[subdomain] = backend;
				
				if(backend.startGameLoopImmediately) {
					console.log(`[${subdomain}] - startGameLoopImmediately`);
					backend.gameloop.start('main');
				}
				resolve(backend);
			} else {
				resolve(backend);
			}
			
			
		});
	}
	
	startGameLoop(subdomain, tag) {
		if(!tag) {
			return { success: false, args: [subdomain, 'no tag provided'] };
		} else if(!this.fetchFromCache(subdomain)) {
			return { success: false, args: [subdomain, 'no backend loaded. Game loop: ', tag] };
		} else if(!this.fetchFromCache(subdomain).update) {
			return { success: false, args: [subdomain, 'backend does not have update method. Game loop: ', tag] };
		} else {
			
			if(!this.cachedGameLoops[subdomain]) {
				this.cachedGameLoops[subdomain] = [];
			}
			if(this.cachedGameLoops[subdomain][tag]) {
				this.cachedGameLoops[subdomain][tag] = undefined;
			}
			
			const updateMethod = this.fetchFromCache(subdomain).update;
			
			if(!updateMethod) {
				return { success: false, args: [subdomain, 'no update method found', tag] };
			}
			
			
			// start the loop at 30 fps (1000/30ms per frame) and grab its id 
	        const gameLoopId = this.gameloop.setGameLoop((delta) => {
	        	
	        	try {
	        		updateMethod(delta, tag);
	        	} catch (err) {
	        		console.log('GAMELOOP ERROR: ' + err, updateMethod);
	        		throw err;
	        	}
	        	
	        	
	        }, 1000 / 30);
	        this.cachedGameLoops[subdomain][tag] = gameLoopId;
	        return { success: true, args: [subdomain, 'game loop started', tag] };
		}
	}
	
	
	stopGameLoop(subdomain, tag) {
		if(this.cachedGameLoops[subdomain] && this.cachedGameLoops[subdomain][tag] !== undefined) {
			this.gameloop.clearGameLoop(this.cachedGameLoops[subdomain][tag]);
			this.cachedGameLoops[subdomain][tag] = undefined;
			//console.log(socket.subdomain, 'game loop cleared', tag);
			return { success: true, args: [subdomain, 'game loop cleared', tag] };
		}else {
			return { success: false, args: [subdomain, 'no such game loop', tag] };
		}
	}
}


module.exports = function(services) {
	return new BackendBuilder(services);
};

