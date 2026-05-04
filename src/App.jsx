import { useEffect, useMemo, useState } from "react";
import * as api from "./api";
import {
  censusTemplateYears,
  getCensusTemplate,
  getTemplateIdForYear,
} from "./templates/censusTemplates";

const STORAGE_KEY = "census-notebook-v1";

const starterData = {
  activeProjectId: "project-1",
  projects: [
    {
      id: "project-1",
      name: "Sample Census Project",
      createdAt: new Date().toISOString(),
      records: [
        {
          id: "record-1",
          year: "1900",
          name: "Hartley Fuller Dame",
          location: "Massachusetts",
          household: "Dame household",
          notes: "Sample record. Replace with your own census entry.",
          bookmarked: true,
          highlighted: false,
        },
        {
          id: "record-2",
          year: "1910",
          name: "Hartley F. Dame",
          location: "California",
          household: "Possible match",
          notes: "Check age, parents, and birthplace before confirming.",
          bookmarked: false,
          highlighted: true,
        },
      ],
    },
  ],
};

function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : starterData;
  } catch {
    return starterData;
  }
}

function normalizeProject(project) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt || project.created_at || new Date().toISOString(),
    records: (project.records || []).map((record) => ({
      id: record.id,
      year: record.year || "",
      name: record.name || "",
      location: record.location || "",
      household: record.household || "",
      notes: record.notes || "",
      bookmarked: Boolean(record.bookmarked),
      highlighted: Boolean(record.highlighted),
    })),
  };
}

function toData(projects, activeProjectId = "") {
  const normalizedProjects = projects.map(normalizeProject);
  const hasActiveProject = normalizedProjects.some((project) => project.id === activeProjectId);

  return {
    activeProjectId: hasActiveProject ? activeProjectId : normalizedProjects[0]?.id || "",
    projects: normalizedProjects,
  };
}

function downloadFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function makeTemplateRows(template, rowCount = 10) {
  return Array.from({ length: rowCount }, () =>
    Object.fromEntries(template.columns.map((column) => [column.key, ""]))
  );
}

function isTemplateRowEmpty(row) {
  return Object.values(row).every((value) => !String(value || "").trim());
}

function templateRowToRecord(template, row) {
  const fullName = [row.givenName, row.surname].filter(Boolean).join(" ").trim();
  const householdParts = [
    row.relationship && `Relationship: ${row.relationship}`,
    row.familyNumber && `Family: ${row.familyNumber}`,
    row.houseNumber && `House: ${row.houseNumber}`,
    row.lineNumber && `Line: ${row.lineNumber}`,
    row.page && `Page: ${row.page}`,
  ].filter(Boolean);

  const noteFields = template.columns
    .filter((column) => !["location", "page", "lineNumber", "houseNumber", "familyNumber", "surname", "givenName", "relationship"].includes(column.key))
    .map((column) => {
      const value = String(row[column.key] || "").trim();
      return value ? `${column.label}: ${value}` : "";
    })
    .filter(Boolean);

  return {
    year: template.year,
    name: fullName || String(row.surname || row.givenName || "").trim(),
    location: String(row.location || "").trim(),
    household: householdParts.join("; "),
    notes: noteFields.join("; "),
    bookmarked: false,
    highlighted: false,
  };
}

function CopyrightFooter() {
  return (
    <footer style={{ marginTop: "24px", padding: "18px", textAlign: "center", color: "#6b7280", fontSize: "14px" }}>
      Copyright {new Date().getFullYear()} Kate Montressor. All rights reserved.
    </footer>
  );
}

function CensusTemplatePage({
  template,
  activeProject,
  onImportRows,
  pageStyle,
  shellStyle,
  headerStyle,
  cardStyle,
  buttonStyle,
  lightButtonStyle,
  inputStyle,
}) {
  const [rows, setRows] = useState(() => makeTemplateRows(template, 12));

  function updateCell(rowIndex, columnKey, value) {
    setRows((prev) =>
      prev.map((row, index) => (index === rowIndex ? { ...row, [columnKey]: value } : row))
    );
  }

  function addBlankRows() {
    setRows((prev) => [...prev, ...makeTemplateRows(template, 5)]);
  }

  function clearRows() {
    const confirmed = window.confirm("Clear all pasted data from this template?");
    if (confirmed) setRows(makeTemplateRows(template, 12));
  }

  function handlePaste(event, startRowIndex, startColumnIndex) {
    const text = event.clipboardData.getData("text");
    if (!text.includes("\t") && !text.includes("\n")) return;

    event.preventDefault();

    const pastedRows = text
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => line.split("\t"));

    setRows((prev) => {
      const next = [...prev];
      const neededRows = startRowIndex + pastedRows.length - next.length;
      if (neededRows > 0) next.push(...makeTemplateRows(template, neededRows));

      pastedRows.forEach((pastedRow, rowOffset) => {
        const rowIndex = startRowIndex + rowOffset;
        const row = { ...next[rowIndex] };

        pastedRow.forEach((value, columnOffset) => {
          const column = template.columns[startColumnIndex + columnOffset];
          if (column) row[column.key] = value;
        });

        next[rowIndex] = row;
      });

      return next;
    });
  }

  async function importRows() {
    const filledRows = rows.filter((row) => !isTemplateRowEmpty(row));
    if (filledRows.length === 0) return;

    await onImportRows(template, filledRows);
    setRows(makeTemplateRows(template, 12));
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <header style={headerStyle}>
          <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
            Census template
          </p>
          <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>{template.label}</h1>
          <div style={{ display: "flex", justifyContent: "center", gap: "10px", flexWrap: "wrap" }}>
            <a href="#/" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Census Notebook
            </a>
            <a
              href={template.sourceWorkbook}
              style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}
            >
              Download Excel Template
            </a>
          </div>
        </header>

        <section style={{ ...cardStyle, padding: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0 }}>Paste or enter census rows</h2>
              <p style={{ color: "#4b5563", margin: "6px 0 0" }}>
                Import target: {activeProject?.name || "select or create a project first"}
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button onClick={addBlankRows} style={lightButtonStyle}>Add Rows</button>
              <button onClick={clearRows} style={lightButtonStyle}>Clear</button>
              <button onClick={importRows} disabled={!activeProject} style={buttonStyle}>Import Filled Rows</button>
            </div>
          </div>

          <div style={{ overflow: "auto", marginTop: "18px", border: "1px solid #e5e7eb", borderRadius: "10px" }}>
            <table style={{ borderCollapse: "collapse", minWidth: "2600px", width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  {template.columns.map((column) => (
                    <th
                      key={column.key}
                      style={{
                        position: "sticky",
                        top: 0,
                        background: "#f3f4f6",
                        borderBottom: "1px solid #d1d5db",
                        borderRight: "1px solid #e5e7eb",
                        padding: "8px",
                        textAlign: "left",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {template.columns.map((column, columnIndex) => (
                      <td key={column.key} style={{ borderBottom: "1px solid #f3f4f6", borderRight: "1px solid #f3f4f6", padding: 0 }}>
                        <input
                          value={row[column.key]}
                          onChange={(event) => updateCell(rowIndex, column.key, event.target.value)}
                          onPaste={(event) => handlePaste(event, rowIndex, columnIndex)}
                          style={{
                            ...inputStyle,
                            width: "100%",
                            minWidth: "96px",
                            border: "none",
                            borderRadius: 0,
                            boxSizing: "border-box",
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <CopyrightFooter />
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(loadData);
  const [currentPage, setCurrentPage] = useState(window.location.hash || "#/");
  const [apiConnected, setApiConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Using browser storage until the FastAPI backend is running.");
  const [query, setQuery] = useState("");
  const [yearFilter, setYearFilter] = useState("all");
  const [showBookmarkedOnly, setShowBookmarkedOnly] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newRecord, setNewRecord] = useState({
    year: "",
    name: "",
    location: "",
    household: "",
    notes: "",
  });

  useEffect(() => {
    let cancelled = false;

    async function loadProjectsFromApi() {
      try {
        const projects = await api.fetchProjects();
        if (cancelled) return;

        setData((prev) => toData(projects, prev.activeProjectId));
        setApiConnected(true);
        setStatusMessage("Connected to FastAPI backend.");
      } catch {
        if (cancelled) return;

        setApiConnected(false);
        setStatusMessage("Using browser storage until the FastAPI backend is running.");
      }
    }

    loadProjectsFromApi();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function syncPageFromHash() {
      setCurrentPage(window.location.hash || "#/");
    }

    window.addEventListener("hashchange", syncPageFromHash);
    return () => window.removeEventListener("hashchange", syncPageFromHash);
  }, []);

  useEffect(() => {
    if (!apiConnected) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  }, [apiConnected, data]);

  const activeProject = data.projects.find((p) => p.id === data.activeProjectId) || data.projects[0];

  const allRecords = useMemo(() => {
    return data.projects.flatMap((project) =>
      project.records.map((record) => ({
        ...record,
        projectName: project.name,
        projectId: project.id,
      }))
    );
  }, [data.projects]);

  const years = useMemo(() => {
    return Array.from(new Set(allRecords.map((r) => r.year).filter(Boolean))).sort();
  }, [allRecords]);

  const filteredRecords = useMemo(() => {
    const q = query.trim().toLowerCase();

    return allRecords.filter((record) => {
      const haystack = [
        record.year,
        record.name,
        record.location,
        record.household,
        record.notes,
        record.projectName,
      ]
        .join(" ")
        .toLowerCase();

      if (q && !haystack.includes(q)) return false;
      if (yearFilter !== "all" && record.year !== yearFilter) return false;
      if (showBookmarkedOnly && !record.bookmarked) return false;
      return true;
    });
  }, [allRecords, query, yearFilter, showBookmarkedOnly]);

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) return;

    if (apiConnected) {
      try {
        const project = normalizeProject(await api.createProject(name));
        setData((prev) => ({
          activeProjectId: project.id,
          projects: [...prev.projects, project],
        }));
        setNewProjectName("");
        return;
      } catch {
        setApiConnected(false);
        setStatusMessage("API request failed. Changes are saving in browser storage for now.");
      }
    }

    const project = {
      id: uid("project"),
      name,
      createdAt: new Date().toISOString(),
      records: [],
    };

    setData((prev) => ({
      activeProjectId: project.id,
      projects: [...prev.projects, project],
    }));

    setNewProjectName("");
  }

  async function deleteActiveProject() {
    if (!activeProject) return;

    const confirmed = window.confirm(
      `Delete "${activeProject.name}" and its ${activeProject.records.length} records? This cannot be undone.`
    );

    if (!confirmed) return;

    if (apiConnected) {
      try {
        await api.deleteProject(activeProject.id);
      } catch {
        setApiConnected(false);
        setStatusMessage("API request failed. Changes are saving in browser storage for now.");
      }
    }

    setData((prev) => {
      const remainingProjects = prev.projects.filter((project) => project.id !== activeProject.id);

      return {
        activeProjectId: remainingProjects[0]?.id || "",
        projects: remainingProjects,
      };
    });
  }

  async function addRecord() {
    if (!activeProject) return;
    if (!newRecord.name.trim() && !newRecord.year.trim()) return;

    const recordDraft = {
      ...newRecord,
      bookmarked: false,
      highlighted: false,
    };

    let record = {
      id: uid("record"),
      ...recordDraft,
    };

    if (apiConnected) {
      try {
        record = await api.createRecord(activeProject.id, recordDraft);
      } catch {
        setApiConnected(false);
        setStatusMessage("API request failed. Changes are saving in browser storage for now.");
      }
    }

    setData((prev) => ({
      ...prev,
      projects: prev.projects.map((project) =>
        project.id === activeProject.id
          ? { ...project, records: [...project.records, normalizeProject({ ...project, records: [record] }).records[0]] }
          : project
      ),
    }));

    setNewRecord({ year: "", name: "", location: "", household: "", notes: "" });
  }

  async function updateRecord(projectId, recordId, changes) {
    if (apiConnected) {
      try {
        await api.updateRecord(recordId, changes);
      } catch {
        setApiConnected(false);
        setStatusMessage("API request failed. Changes are saving in browser storage for now.");
      }
    }

    setData((prev) => ({
      ...prev,
      projects: prev.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              records: project.records.map((record) =>
                record.id === recordId ? { ...record, ...changes } : record
              ),
            }
          : project
      ),
    }));
  }

  async function deleteRecord(projectId, recordId) {
    if (apiConnected) {
      try {
        await api.deleteRecord(recordId);
      } catch {
        setApiConnected(false);
        setStatusMessage("API request failed. Changes are saving in browser storage for now.");
      }
    }

    setData((prev) => ({
      ...prev,
      projects: prev.projects.map((project) =>
        project.id === projectId
          ? { ...project, records: project.records.filter((record) => record.id !== recordId) }
          : project
      ),
    }));
  }

  async function importTemplateRows(template, templateRows) {
    if (!activeProject) return;

    const records = templateRows.map((row) => templateRowToRecord(template, row));
    const savedRecords = [];

    if (apiConnected) {
      try {
        for (const record of records) {
          savedRecords.push(await api.createRecord(activeProject.id, record));
        }
      } catch {
        setApiConnected(false);
        setStatusMessage("API request failed. Changes are saving in browser storage for now.");
      }
    }

    const recordsToAdd = savedRecords.length > 0 ? savedRecords : records.map((record) => ({ id: uid("record"), ...record }));

    setData((prev) => ({
      ...prev,
      projects: prev.projects.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              records: [
                ...project.records,
                ...normalizeProject({ ...project, records: recordsToAdd }).records,
              ],
            }
          : project
      ),
    }));
  }

  function exportJson() {
    downloadFile("census-notebook-export.json", JSON.stringify(data, null, 2));
  }

  const pageStyle = {
    minHeight: "100vh",
    background: "#f3f4f6",
    color: "#111827",
    fontFamily: "Arial, Helvetica, sans-serif",
    padding: "24px",
  };

  const shellStyle = {
    maxWidth: "1300px",
    margin: "0 auto",
  };

  const headerStyle = {
    background: "white",
    padding: "32px",
    borderRadius: "18px",
    boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
    marginBottom: "24px",
    textAlign: "center",
  };

  const mainStyle = {
    display: "grid",
    gridTemplateColumns: "320px 1fr",
    gap: "24px",
    alignItems: "start",
  };

  const sidebarStyle = {
    position: "sticky",
    top: "20px",
    alignSelf: "start",
  };

  const cardStyle = {
    background: "white",
    padding: "20px",
    borderRadius: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
    marginBottom: "16px",
  };

  const navLinkStyle = {
    display: "block",
    padding: "14px",
    background: "#e5e7eb",
    borderRadius: "12px",
    textDecoration: "none",
    color: "#111827",
    fontWeight: "700",
    textAlign: "center",
  };

  const buttonStyle = {
    padding: "10px 14px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    background: "#111827",
    color: "white",
    cursor: "pointer",
    fontWeight: "700",
  };

  const lightButtonStyle = {
    padding: "10px 14px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    background: "#f9fafb",
    color: "#111827",
    cursor: "pointer",
    fontWeight: "600",
  };

  const inputStyle = {
    padding: "10px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    fontSize: "14px",
  };

  const sectionTitleStyle = {
    marginTop: 0,
    marginBottom: "14px",
    fontSize: "22px",
  };

  const helpArticleStyle = {
    ...cardStyle,
    maxWidth: "980px",
    margin: "0 auto",
    padding: "32px",
    textAlign: "left",
    lineHeight: 1.65,
  };

  const helpHeadingStyle = {
    fontSize: "34px",
    margin: "0 0 12px",
  };

  const helpSectionStyle = {
    borderTop: "1px solid #e5e7eb",
    marginTop: "24px",
    paddingTop: "22px",
  };

  const codeBlockStyle = {
    display: "block",
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "14px",
    whiteSpace: "pre-wrap",
    color: "#111827",
    fontSize: "14px",
    overflowX: "auto",
  };

  if (currentPage === "#/templates/create") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Custom template
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Create Template</h1>
            <a href="#/" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Census Notebook
            </a>
          </header>

          <section style={{ ...cardStyle, maxWidth: "820px", margin: "0 auto", textAlign: "left" }}>
            <h2 style={sectionTitleStyle}>Build a custom census template</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: "12px" }}>
              <input placeholder="Template name" style={inputStyle} />
              <input placeholder="Year" style={inputStyle} />
            </div>
            <textarea
              placeholder="Paste column headers here, one per line or separated by commas"
              style={{
                ...inputStyle,
                width: "100%",
                minHeight: "180px",
                boxSizing: "border-box",
                marginTop: "12px",
                fontFamily: "Arial, Helvetica, sans-serif",
              }}
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
              <button style={lightButtonStyle}>Import CSV Headers</button>
              <button style={buttonStyle}>Save Template</button>
            </div>
          </section>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage.startsWith("#/templates/")) {
    const templateId = currentPage.replace("#/templates/", "");
    const template = getCensusTemplate(templateId);
    const templateYear = templateId.replace("us-census-", "");

    if (template) {
      return (
        <CensusTemplatePage
          template={template}
          activeProject={activeProject}
          onImportRows={importTemplateRows}
          pageStyle={pageStyle}
          shellStyle={shellStyle}
          headerStyle={headerStyle}
          cardStyle={cardStyle}
          buttonStyle={buttonStyle}
          lightButtonStyle={lightButtonStyle}
          inputStyle={inputStyle}
        />
      );
    }

    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Census template
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>{templateYear} Census</h1>
            <a href="#/" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Census Notebook
            </a>
          </header>

          <section style={{ ...cardStyle, maxWidth: "760px", margin: "0 auto", textAlign: "left" }}>
            <h2 style={sectionTitleStyle}>Template data coming later</h2>
            <p style={{ color: "#4b5563", lineHeight: 1.6 }}>
              This year is available in the template picker. The spreadsheet-style fields will appear
              here once the template data is added.
            </p>
          </section>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help center
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Census Notebook Help</h1>
            <a href="#/" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Census Notebook
            </a>
          </header>

          <main style={{ maxWidth: "980px", margin: "0 auto", textAlign: "left" }}>
            <section style={{ ...cardStyle, padding: "28px" }}>
              <h2 style={{ ...sectionTitleStyle, fontSize: "28px" }}>Topics</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px" }}>
                <a href="#/help/ocr-import" style={{ ...navLinkStyle, textAlign: "left", background: "#f9fafb" }}>
                  <strong>OCR census data for import</strong>
                  <br />
                  <span style={{ color: "#4b5563", fontWeight: "400" }}>
                    Turn OCR text into clean spreadsheet rows and import-ready CSV files.
                  </span>
                </a>
                <a href="#/help/census-years" style={{ ...navLinkStyle, textAlign: "left", background: "#f9fafb" }}>
                  <strong>Census versions through the years</strong>
                  <br />
                  <span style={{ color: "#4b5563", fontWeight: "400" }}>
                    Understand how census questions and available fields changed over time.
                  </span>
                </a>
                <a href="#/help/templates" style={{ ...navLinkStyle, textAlign: "left", background: "#f9fafb" }}>
                  <strong>Use census templates</strong>
                  <br />
                  <span style={{ color: "#4b5563", fontWeight: "400" }}>
                    Choose a template, prepare columns, and keep imports consistent.
                  </span>
                </a>
              </div>
            </section>
          </main>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/census-years" || currentPage === "#/help/templates") {
    const isTemplatesPage = currentPage === "#/help/templates";

    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>
              {isTemplatesPage ? "Use Census Templates" : "Census Versions Through the Years"}
            </h1>
            <a href="#/help" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Help
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>{isTemplatesPage ? "Template guide coming next" : "Census year guide coming next"}</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              This topic is set up as a separate Help page so it can grow into a hosted article.
            </p>
            <section style={helpSectionStyle}>
              <h3>{isTemplatesPage ? "What this page will cover" : "What this page will cover"}</h3>
              {isTemplatesPage ? (
                <ul>
                  <li>Choosing the correct census-year template.</li>
                  <li>Matching spreadsheet columns to Census Notebook fields.</li>
                  <li>Handling blank, uncertain, or extra fields before import.</li>
                </ul>
              ) : (
                <ul>
                  <li>Which census years captured different household details.</li>
                  <li>How fields changed across 1850, 1860, 1870, 1880, 1900, 1910, 1920, 1930, 1940, and 1950.</li>
                  <li>What each census version can and cannot prove in a genealogy project.</li>
                </ul>
              )}
            </section>
          </article>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/ocr-import") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>OCR Census Data for Import</h1>
            <a href="#/help" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Help
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Prepare census OCR text for Census Notebook</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              This workflow turns a census image into clean spreadsheet rows that can be imported
              with the CSV importer.
            </p>

            <section style={helpSectionStyle}>
              <h3>1. Start with a clear census image</h3>
              <p>
                Use the highest-resolution image available. Crop away borders or unrelated page
                areas when possible, but keep the column headings visible if they help you identify
                the fields.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>2. Run OCR or HTR</h3>
              <p>
                For handwritten census records, use Transkribus when available. For typed or very
                clean printed records, Tesseract can be a useful fallback. After OCR finishes, skim
                the result for common recognition errors in names, dates, place names, and ditto marks.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>3. Paste the OCR text into a spreadsheet</h3>
              <p>
                Open a spreadsheet and create one row per census record. If the OCR output is messy,
                paste it into a scratch sheet first, then copy cleaned values into the import sheet.
              </p>
              <p>The CSV import currently expects these columns:</p>
              <code style={codeBlockStyle}>year,name,location,household,notes</code>
            </section>

            <section style={helpSectionStyle}>
              <h3>4. Clean and standardize the rows</h3>
              <ul>
                <li>Use the census year in the <strong>year</strong> column, such as 1900 or 1910.</li>
                <li>Put the person or target ancestor in the <strong>name</strong> column.</li>
                <li>Use city, county, state, or country in <strong>location</strong>.</li>
                <li>Use <strong>household</strong> for family group, dwelling, page, or match notes.</li>
                <li>Use <strong>notes</strong> for uncertainty, OCR corrections, ages, occupations, and source details.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>5. Export as CSV</h3>
              <p>
                Save or download the spreadsheet as a CSV file. Keep the header row exactly as shown
                so Census Notebook can match each column during import.
              </p>
              <code style={codeBlockStyle}>
                year,name,location,household,notes{"\n"}
                1900,Jane Doe,Boston Massachusetts,Doe household,Possible match; verify age and birthplace
              </code>
            </section>

            <section style={helpSectionStyle}>
              <h3>6. Import into Census Notebook</h3>
              <p>
                Return to Census Notebook, choose the project, then use Import to select the CSV.
                Review the imported rows, bookmark important people, and highlight records that need
                more verification.
              </p>
            </section>
          </article>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <header style={headerStyle}>
          <h1 style={{ fontSize: "56px", margin: "10px 0 20px" }}>Census Notebook</h1>
          <div style={{ maxWidth: "900px", margin: "0 auto", color: "#4b5563", fontSize: "20px", lineHeight: 1.5 }}>
            <p>Census Notebook can be used to track US census data for genealogy projects.</p>
            <p>
              This tool can connect to a FastAPI and PostgreSQL backend, with browser storage
              available while local services are offline.
            </p>
            <p>You can bookmark specific people, search, and analyze across multiple projects and years.</p>
          </div>
          <p style={{ marginTop: "16px", color: apiConnected ? "#047857" : "#92400e", fontWeight: "700" }}>
            {statusMessage}
          </p>
          <a
            href="#/help"
            style={{ ...buttonStyle, display: "inline-block", marginTop: "10px", textDecoration: "none" }}
          >
            Help
          </a>
        </header>

        <main style={mainStyle}>
          <aside style={sidebarStyle}>
            <nav style={cardStyle}>
              <h2 style={sectionTitleStyle}>Tasks</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <a style={navLinkStyle} href="#projects">Create a New Project</a>
                <a style={navLinkStyle} href="#templates">Select a Census Template</a>
                <a style={navLinkStyle} href="#add-record">Add a Record</a>
                <a style={navLinkStyle} href="#search">Search and Analyze</a>
                <a style={navLinkStyle} href="#/help">Help</a>
              </div>
            </nav>

            <section id="projects" style={cardStyle}>
              <h2 style={sectionTitleStyle}>Projects</h2>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {data.projects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => setData((prev) => ({ ...prev, activeProjectId: project.id }))}
                    style={project.id === activeProject?.id ? buttonStyle : lightButtonStyle}
                  >
                    {project.name}
                    <br />
                    <span style={{ fontSize: "12px", fontWeight: "400" }}>{project.records.length} records</span>
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
                <input
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="New project name"
                  style={{ ...inputStyle, minWidth: 0, flex: 1 }}
                />
                <button onClick={createProject} style={buttonStyle}>Add</button>
              </div>

              <button
                onClick={deleteActiveProject}
                disabled={!activeProject}
                style={{
                  ...lightButtonStyle,
                  width: "100%",
                  marginTop: "10px",
                  color: activeProject ? "#dc2626" : "#9ca3af",
                  cursor: activeProject ? "pointer" : "not-allowed",
                }}
              >
                Delete Selected Project
              </button>
            </section>

            <section id="templates" style={cardStyle}>
              <h2 style={sectionTitleStyle}>Templates</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
                {censusTemplateYears.map((year) => (
                  <a
                    key={year}
                    href={`#/templates/${getTemplateIdForYear(year)}`}
                    style={{ ...navLinkStyle, background: "#f9fafb", padding: "10px", textAlign: "center" }}
                  >
                    {year}
                  </a>
                ))}
              </div>
              <a
                href="#/templates/create"
                style={{ ...buttonStyle, display: "block", marginTop: "12px", textDecoration: "none", textAlign: "center" }}
              >
                Create Template
              </a>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Analysis Ideas</h2>
              <ul style={{ color: "#4b5563", lineHeight: 1.7, paddingLeft: "20px" }}>
                <li>Missing census years for a person</li>
                <li>Name spelling variations</li>
                <li>Unexpected location changes</li>
                <li>Age conflicts between records</li>
              </ul>
            </section>
          </aside>

          <section>
            <section id="add-record" style={cardStyle}>
              <h2 style={sectionTitleStyle}>Add Record to {activeProject?.name || "a project"}</h2>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: "10px" }}>
                {[
                  ["year", "Year"],
                  ["name", "Name"],
                  ["location", "Location"],
                  ["household", "Household"],
                  ["notes", "Notes"],
                ].map(([key, label]) => (
                  <input
                    key={key}
                    value={newRecord[key]}
                    onChange={(e) => setNewRecord((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder={label}
                    style={inputStyle}
                  />
                ))}
              </div>

              <button onClick={addRecord} disabled={!activeProject} style={{ ...buttonStyle, marginTop: "14px" }}>
                Add Record
              </button>
            </section>

            <section id="search" style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                <h2 style={sectionTitleStyle}>Search All Projects</h2>

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search name, place, note, project..."
                    style={{ ...inputStyle, minWidth: "280px" }}
                  />

                  <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} style={inputStyle}>
                    <option value="all">All years</option>
                    {years.map((year) => (
                      <option key={year} value={year}>{year}</option>
                    ))}
                  </select>

                  <label style={{ display: "flex", alignItems: "center", gap: "8px", ...inputStyle }}>
                    <input
                      type="checkbox"
                      checked={showBookmarkedOnly}
                      onChange={(e) => setShowBookmarkedOnly(e.target.checked)}
                    />
                    Bookmarked
                  </label>
                </div>
              </div>

              <div style={{ overflowX: "auto", marginTop: "18px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                  <thead>
                    <tr style={{ background: "#f3f4f6" }}>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Year</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Name</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Location</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Household</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Project</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Notes</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredRecords.map((record) => (
                      <tr key={record.id} style={{ background: record.highlighted ? "#fef9c3" : "white" }}>
                        <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>{record.year}</td>
                        <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>{record.name}</td>
                        <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>{record.location}</td>
                        <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>{record.household}</td>
                        <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>{record.projectName}</td>
                        <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>{record.notes}</td>
                        <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            <button
                              onClick={() => updateRecord(record.projectId, record.id, { bookmarked: !record.bookmarked })}
                              style={lightButtonStyle}
                            >
                              {record.bookmarked ? "★" : "☆"}
                            </button>
                            <button
                              onClick={() => updateRecord(record.projectId, record.id, { highlighted: !record.highlighted })}
                              style={lightButtonStyle}
                            >
                              Highlight
                            </button>
                            <button
                              onClick={() => deleteRecord(record.projectId, record.id)}
                              style={{ ...lightButtonStyle, color: "#dc2626" }}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {filteredRecords.length === 0 && (
                      <tr>
                        <td colSpan="7" style={{ padding: "28px", textAlign: "center", color: "#6b7280" }}>
                          No records found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Backup</h2>
              <p style={{ color: "#4b5563" }}>Export your current client-side data as a JSON backup file.</p>
              <button onClick={exportJson} style={buttonStyle}>Export Backup</button>
            </section>
          </section>
        </main>
        <CopyrightFooter />
      </div>
    </div>
  );
}
