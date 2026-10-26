const { createApiServer } = require('./http-api');

const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new TypeError('PORT must be an integer between 1 and 65535');
}

const { server } = createApiServer();
server.listen(port, host, () => {
  console.log(`Forge Studio API listening on ${host}:${port}`);
});

function shutdown(signal) {
  server.close((error) => {
    if (error) {
      console.error(`Failed to close server after ${signal}`, error.message);
      process.exitCode = 1;
    }
    process.exit();
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
