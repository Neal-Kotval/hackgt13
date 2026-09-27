import type { Metadata } from "next";
import DesignSystem from "../../components/design-system";
import "./design-system.css";

export const metadata: Metadata = {
  title: "Design system — alto",
  description: "The token contract behind alto: color, typography, spacing, and interface states.",
};

export default function DesignSystemPage() {
  return <DesignSystem />;
}
