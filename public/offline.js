// Reconnect automatically when the network comes back.
document.getElementById('retry').onclick = () => location.reload();
window.addEventListener('online', () => location.reload());
setInterval(() => fetch('/', { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok && location.reload()).catch(() => {}), 15000);
