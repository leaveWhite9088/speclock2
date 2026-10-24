/** Parameters several tools share. */

import { Type } from "@earendil-works/pi-ai";

export const agentParam = Type.Optional(
	Type.String({
		description:
			'Which agent instance to use: a type name, or the id of an instance from agent_instances. Default "mcode".',
	}),
);
