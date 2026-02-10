"use client";

import dynamic from "next/dynamic";

const DopamineResetCoachPrototype = dynamic(
  () => import("@/components/DopamineResetCoachPrototype"),
  { ssr: false }
);

export default function Page() {
  return <DopamineResetCoachPrototype />;
}
