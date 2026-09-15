import type { ReactNode } from "react";
import { Navigate } from "../lib/router";
import { useLiveServicesEnabled } from "../hooks/useLiveServicesEnabled";

export function LiveServicesExperimentalGate({ children, route = false }: { children: ReactNode; route?: boolean }) {
  const { enabled, loaded } = useLiveServicesEnabled();
  if (!loaded) return null;
  if (!enabled) return route ? <Navigate to="/dashboard" replace /> : null;
  return <>{children}</>;
}
