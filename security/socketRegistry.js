const socketsByUser = new Map();

function register(socket) {
    const userId = String(socket.data.user._id);
    if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
    socketsByUser.get(userId).add(socket);
}

function unregister(socket) {
    const userId = String(socket.data.user._id);
    const sockets = socketsByUser.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) socketsByUser.delete(userId);
}

function disconnectUser(userId) {
    const sockets = socketsByUser.get(String(userId));
    if (!sockets) return;
    for (const socket of sockets) socket.disconnect(true);
}

module.exports = { register, unregister, disconnectUser };
