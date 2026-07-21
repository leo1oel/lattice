import { routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";

/**
 * Yjs document room for Lattice live sharing.
 * Deployed to your own Cloudflare account (workers.dev), not partykit.dev.
 */
export class LatticeDoc extends YServer {
  static options = {
    hibernate: true,
  };
}

type Env = {
  LatticeDoc: DurableObjectNamespace<LatticeDoc>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env))
      ?? new Response("Lattice collab server", { status: 200 })
    );
  },
} satisfies ExportedHandler<Env>;
