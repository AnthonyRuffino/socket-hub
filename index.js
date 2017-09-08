var SocketHub = {};
SocketHub.sockets = null;
SocketHub.children = null;

SocketHub.init = function(children, socketio, server){
    SocketHub.sockets = [];
    SocketHub.children = children;
    
    if(SocketHub.children !== undefined && SocketHub.children !== null){
      SocketHub.children.forEach(function (child) {
      	child.socketHub = SocketHub;
        child.init();
      });
    }
    
    socketio.listen(server).on('connection', SocketHub.onConnection);
};


SocketHub.onConnection = function (socket) {

    SocketHub.sockets.push(socket);

    socket.on('disconnect', function () {
      SocketHub.sockets.splice(SocketHub.sockets.indexOf(socket), 1);
      
      if(SocketHub.children !== undefined && SocketHub.children !== null){
        SocketHub.children.forEach(function (child) {
          if(child.onDisconnection !== undefined){
            child.onDisconnection(SocketHub.sockets);
          }
        });
      }
      
    });
    
    if(SocketHub.children !== undefined && SocketHub.children !== null){
      SocketHub.children.forEach(function (child) {
        child.onConnection(socket);
      });
    }
    
};
    

SocketHub.broadcast = function(event, data) {
  SocketHub.sockets.forEach(function (socket) {
    socket.emit(event, data);
  });
}


exports.init = SocketHub.init;







