const socket = io({ autoConnect: false });
const input = document.getElementById("chat_box");
const messages = document.getElementById("messages");
const sendBtn = document.getElementById("send");
const onlineUsersList = document.getElementById("online_users");
const status = document.getElementById("send-status");
const main = document.getElementById("main-container");
const roomid = main.dataset.roomid;
const user = main.dataset.user;
const userId = main.dataset.userId;
const pending = new Map();
const displayedMessageIds = new Set(Array.from(messages.querySelectorAll("[data-message-id]"), (node) => node.dataset.messageId));

sendBtn.addEventListener("click", sendMessage);
input.addEventListener("keypress", (event) => {
    if (event.key === "Enter") sendMessage();
});

function sendMessage() {
    const message = input.value.trim();
    if (!message) return;
    const requestId = crypto.randomUUID();
    pending.set(requestId, message);
    socket.emit("new_msg", { message, roomid, requestId }, (result) => {
        if (!result || !result.ok) {
            pending.delete(requestId);
            status.textContent = result?.error || "Message could not be sent";
        } else if (pending.has(requestId)) {
            status.textContent = "Message queued; saving…";
        }
    });
}

socket.on("message_status", (result) => {
    const sentText = pending.get(result.requestId);
    if (sentText === undefined) return;
    pending.delete(result.requestId);
    if (result.ok) {
        if (input.value.trim() === sentText) input.value = "";
        status.textContent = "Message saved";
    } else {
        status.textContent = "Message was not saved. Please try again.";
    }
});

socket.on("connect", () => {
    status.textContent = "Connected";
    socket.emit("join_room", { roomid }, (result) => {
        if (result && result.ok) sendBtn.disabled = false;
        else {
            sendBtn.disabled = true;
            status.textContent = result?.error || "Unable to join room";
        }
    });
});
socket.on("disconnect", () => {
    sendBtn.disabled = true;
    status.textContent = "Disconnected. Reconnecting…";
});
socket.on("connect_error", (error) => { status.textContent = error.message; });
socket.on("server_error", (message) => { status.textContent = message; });

socket.on("msg_rcvd", (data) => {
    if (data.messageId && displayedMessageIds.has(data.messageId)) return;
    if (data.messageId) displayedMessageIds.add(data.messageId);
    const item = document.createElement("div");
    item.classList.add("message", data.senderId === userId ? "self" : "other");
    if (data.messageId) item.dataset.messageId = data.messageId;
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = data.sender;
    item.append(sender, document.createTextNode(data.message));
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
});

socket.on("update_online_users", (users) => {
    onlineUsersList.replaceChildren();
    for (const username of users.filter((name) => typeof name === "string" && name.trim())) {
        const item = document.createElement("li");
        item.textContent = username;
        onlineUsersList.appendChild(item);
    }
});

window.addEventListener("load", () => {
    messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
});

socket.connect();
