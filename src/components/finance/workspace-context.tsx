import { createContext, useContext } from "react";
import type { ISODate } from "@/lib/domain";
import type { FinanceAdvicePayload, FinanceHubPayload } from "@/lib/finance-types";

export type FinanceWorkspaceContextValue = {
  hub: FinanceHubPayload;
  today: ISODate;
  month: string;
  advice: FinanceAdvicePayload | null;
  adviceLoading: boolean;
  reload: () => Promise<void>;
  flash: (msg: string, ms?: number) => void;
};

export const FinanceWorkspaceContext = createContext<FinanceWorkspaceContextValue | null>(null);

export function useFinanceWorkspace(): FinanceWorkspaceContextValue {
  const value = useContext(FinanceWorkspaceContext);
  if (!value) {
    throw new Error("useFinanceWorkspace must be used under the Finance layout");
  }
  return value;
}
