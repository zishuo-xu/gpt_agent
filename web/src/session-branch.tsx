import type { ReactNode } from "react";

/** 右栏统一卡片容器 */
export function RailCard(props: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rail-card">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

export function KeyValue(props: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`rail-kv ${props.tone ?? ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
