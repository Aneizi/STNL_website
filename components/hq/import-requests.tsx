"use client";

import type { CSSProperties } from "react";
import {
  attachColosseumProject, createProjectFromImportRequest, resolveBuilderImportRequest,
} from "@/lib/hq/actions/builders-admin";
import type { BuilderImportRequest } from "@/lib/hq/builder-admin-queries";
import { ActionForm, loginLabel, projectHref } from "./builder-admin";

/**
 * The Projects page's Import requests section: the help requests builders
 * sent when Colosseum could not return their project. Creating the HQ
 * project is what answers a request (no Colosseum id is invented for it, and
 * nothing about it is marked submitted); when Colosseum can return the
 * project later, it is linked to that same HQ project rather than imported
 * beside it. The section always renders, with nothing under the heading
 * while there is no request.
 *
 * Styled inline to the design rather than through builder-admin.module.css,
 * which belongs to the Admin page; ActionForm's own fieldset and feedback
 * line still come from there.
 */

const section: CSSProperties = {
  marginTop: 28,
  background: "var(--card)",
  padding: 24,
  boxShadow: "var(--shadow-1)",
  color: "var(--label-1)",
  fontSize: 17,
};

const heading: CSSProperties = {
  margin: 0,
  fontFamily: "var(--serif)",
  fontSize: 30,
  fontWeight: 400,
  lineHeight: 1.2,
};

const article: CSSProperties = { background: "var(--fill-4)", padding: 20, marginTop: 16, minWidth: 0 };

const header: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  flexWrap: "wrap",
};

const title: CSSProperties = { margin: 0, fontSize: 20, fontWeight: 600 };

const badge: CSSProperties = {
  display: "inline-flex",
  padding: "4px 8px",
  background: "var(--fill-3)",
  color: "var(--label-2)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const line: CSSProperties = { margin: "8px 0 0", color: "var(--label-2)", lineHeight: 1.5 };

const link: CSSProperties = { textDecoration: "underline", textUnderlineOffset: 3, overflowWrap: "anywhere" };

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(288px, 100%), 1fr))",
  gap: 16,
  marginTop: 20,
};

const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 };

const input: CSSProperties = {
  width: "100%",
  minHeight: 48,
  padding: "10px 12px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  font: "inherit",
  boxSizing: "border-box",
};

const actions: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 16 };

const button: CSSProperties = {
  display: "inline-flex",
  justifyContent: "center",
  alignItems: "center",
  minHeight: 48,
  padding: "10px 16px",
  border: "1px solid var(--label-1)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};

export function ImportRequests({ requests }: { requests: BuilderImportRequest[] }) {
  return (
    <section style={section} aria-labelledby="import-requests-title">
      <h2 id="import-requests-title" style={heading}>Import requests</h2>
      {requests.map((request) => {
        const href = projectHref(request.projectUrl);
        return (
          <article style={article} key={request.id}>
            <div style={header}>
              <h3 style={title}>{request.name}</h3>
              <span style={badge}>{request.status}</span>
            </div>
            <p style={line}>{loginLabel(request)}</p>
            <p style={line}>
              {href
                ? <a href={href} target="_blank" rel="noopener noreferrer" style={link}>{request.projectUrl}</a>
                : <span style={{ overflowWrap: "anywhere" }}>{request.projectUrl}</span>}
            </p>
            <p style={line}>{request.note}</p>
            {request.projectId ? (
              <>
                <p style={line}>HQ project: {request.projectName}. It has no Colosseum project linked yet.</p>
                <ActionForm action={(data) => attachColosseumProject({ projectId: request.projectId!, url: String(data.get("url") ?? "") })}>
                  <div style={grid}>
                    <label style={field} htmlFor={`import-url-${request.id}`}>
                      Colosseum project URL
                      <input id={`import-url-${request.id}`} name="url" type="url" defaultValue={request.projectUrl} required style={input} />
                    </label>
                  </div>
                  <div style={actions}><button style={button} type="submit">Link this Colosseum project</button></div>
                </ActionForm>
              </>
            ) : (
              <ActionForm action={(data) => createProjectFromImportRequest({ requestId: request.id, name: String(data.get("name") ?? "") })}>
                <div style={grid}>
                  <label style={field} htmlFor={`import-name-${request.id}`}>
                    Project name in HQ
                    <input id={`import-name-${request.id}`} name="name" defaultValue="" maxLength={200} required style={input} />
                  </label>
                </div>
                <div style={actions}><button style={button} type="submit">Create the HQ project</button></div>
              </ActionForm>
            )}
            {request.status === "pending" && (
              <ActionForm action={() => resolveBuilderImportRequest(request.id)}>
                <div style={actions}><button style={button} type="submit">Mark resolved</button></div>
              </ActionForm>
            )}
          </article>
        );
      })}
    </section>
  );
}
