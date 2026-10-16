import { createFileRoute, redirect } from "@tanstack/react-router";
import { AgentObservatoryPage } from "../observatory/AgentObservatoryPage";

export const Route = createFileRoute("/observatory")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: AgentObservatoryPage,
});
