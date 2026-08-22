// Vercel discovers serverless functions by filesystem convention: a function is
// a file under `api/` at the deployment root, and there is no config that moves
// one elsewhere. So this file has to exist here, and holds nothing but the
// pointer — the entrypoint itself lives with the rest of the deployment in
// deploy/vercel/, and nothing outside that folder imports it.
import handler from '../deploy/vercel/handler.js'

export default handler
