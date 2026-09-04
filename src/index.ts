/** Entry point. */
import { loadConfig, describeConfig } from "./config.ts"
import { createApp } from "./server.ts"

const config = loadConfig()
const app = createApp(config)

app.server.listen(config.port, config.host, () => {
  // describeConfig() never includes the credential value.
  process.stdout.write(
    `opencode-free-api listening on http://${config.host}:${config.port}\n` +
      `${JSON.stringify(describeConfig(config), null, 2)}\n`,
  )
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.server.close(() => process.exit(0))
    // Do not let a hung connection block shutdown forever.
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
