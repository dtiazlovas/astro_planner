// Vercel finds functions by convention — a file under `api/` at the deployment
// root, with no config to move it — so this pointer has to live here. The
// entrypoint itself is in deploy/vercel/.
import handler from '../deploy/vercel/handler.js'

export default handler
