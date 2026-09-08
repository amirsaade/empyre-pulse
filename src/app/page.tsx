import { Dashboard } from "@/components/dashboard";
import { MARKETS } from "@/lib/inside-airbnb";

export default function Page() {
  return <Dashboard markets={MARKETS} />;
}
