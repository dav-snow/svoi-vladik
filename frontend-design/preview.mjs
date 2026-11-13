// Старый URL предпросмотра обращается к тому же API и интерфейсу на :8000.
import { createServer, request } from 'node:http';
const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Некорректный PORT');
const server = createServer((incoming, outgoing) => {
  const upstream = request({ hostname: '127.0.0.1', port: 8000, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, host: '127.0.0.1:8000' } }, response => {
    outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
  });
  upstream.on('error', () => {
    outgoing.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    outgoing.end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Свой Владик — запуск</title><body style="font:16px/1.6 system-ui;max-width:640px;margin:10vh auto;padding:24px"><h1>Запустите весь проект</h1><p>Откройте start.cmd в папке проекта или выполните npm start. Карта, места, маршруты и квесты работают вместе с API.</p><a href="http://127.0.0.1:8000/">Открыть Свой Владик</a></body></html>');
  });
  incoming.pipe(upstream);
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Порт ${port} уже занят. Откройте http://127.0.0.1:8000/` : 'Не удалось запустить предпросмотр'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}/ → http://127.0.0.1:8000/`));
