import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import {
  censusTemplates,
  censusTemplateYears,
  getTemplateIdForYear,
} from "./templates/censusTemplates";

const STORAGE_KEY = "census-notebook-v1";
const CUSTOM_TEMPLATES_KEY = "census-notebook-custom-templates-v1";

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

function loadCustomTemplates() {
  try {
    const raw = localStorage.getItem(CUSTOM_TEMPLATES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function slugifyTemplateId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function columnKeyFromLabel(label, existingKeys = new Set()) {
  const baseKey = slugifyTemplateId(label).replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase()) || "column";
  let key = baseKey;
  let counter = 2;

  while (existingKeys.has(key)) {
    key = `${baseKey}${counter}`;
    counter += 1;
  }

  existingKeys.add(key);
  return key;
}

function parseColumnLabels(text) {
  return text
    .split(/\r?\n|,/)
    .map((label) => label.trim())
    .filter(Boolean);
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
  if (template.starterRows) {
    return template.starterRows.map((row) => ({ ...row }));
  }

  return Array.from({ length: rowCount }, () =>
    Object.fromEntries(template.columns.map((column) => [column.key, ""]))
  );
}

function makeBlankTemplateRows(template, rowCount = 5) {
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

function getNoteValue(notes, labels) {
  const parts = String(notes || "").split(";").map((part) => part.trim());

  for (const label of labels) {
    const match = parts.find((part) => part.toLowerCase().startsWith(`${label.toLowerCase()}:`));
    if (match) return match.slice(match.indexOf(":") + 1).trim();
  }

  return "";
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
  onRenameTemplate,
  pageStyle,
  shellStyle,
  headerStyle,
  cardStyle,
  buttonStyle,
  lightButtonStyle,
  inputStyle,
}) {
  const [rows, setRows] = useState(() => makeTemplateRows(template, 12));
  const [pastedTemplateText, setPastedTemplateText] = useState("");
  const [attachedFiles, setAttachedFiles] = useState([]);
  const attachedFilesRef = useRef([]);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(template.label);
  const [templateFilter, setTemplateFilter] = useState({
    lastName: "",
    firstName: "",
    location: "",
  });

  const filteredTemplateRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const lastName = templateFilter.lastName.trim().toLowerCase();
      const firstName = templateFilter.firstName.trim().toLowerCase();
      const location = templateFilter.location.trim().toLowerCase();

      const rowLastName = String(row.surname || row.lastName || row.name || "").toLowerCase();
      const rowFirstName = String(row.givenName || row.firstName || row.name || "").toLowerCase();
      const rowLocation = String(row.location || row.city || row.county || row.state || "").toLowerCase();

      if (lastName && !rowLastName.includes(lastName)) return false;
      if (firstName && !rowFirstName.includes(firstName)) return false;
      if (location && !rowLocation.includes(location)) return false;
      return true;
    });

  const hasTemplateFilter = Object.values(templateFilter).some((value) => value.trim());

  useEffect(() => {
    attachedFilesRef.current = attachedFiles;
  }, [attachedFiles]);

  useEffect(() => {
    return () => {
      attachedFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url));
    };
  }, []);

  function updateCell(rowIndex, columnKey, value) {
    setRows((prev) =>
      prev.map((row, index) => (index === rowIndex ? { ...row, [columnKey]: value } : row))
    );
  }

  function addBlankRows() {
    setRows((prev) => [...prev, ...makeBlankTemplateRows(template, 5)]);
  }

  function clearRows() {
    const confirmed = window.confirm("Clear all pasted data from this template?");
    if (confirmed) setRows(makeTemplateRows(template, 12));
  }

  function resetTemplateFilter() {
    setTemplateFilter({ lastName: "", firstName: "", location: "" });
  }

  function handlePaste(event, startRowIndex, startColumnIndex) {
    const text = event.clipboardData.getData("text");
    if (!text.includes("\t") && !text.includes("\n")) return;

    event.preventDefault();
    applyPastedTextToRows(text, startRowIndex, startColumnIndex);
  }

  function applyPastedTextToRows(text, startRowIndex = 0, startColumnIndex = 0) {
    const pastedRows = text
      .trimEnd()
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => (line.includes("\t") ? line.split("\t") : line.split(",")));

    if (pastedRows.length === 0) return;

    setRows((prev) => {
      const next = [...prev];
      const neededRows = startRowIndex + pastedRows.length - next.length;
      if (neededRows > 0) next.push(...makeBlankTemplateRows(template, neededRows));

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

  function applyPasteBox() {
    applyPastedTextToRows(pastedTemplateText);
    setPastedTemplateText("");
  }

  function importCsvFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      applyPastedTextToRows(String(reader.result || ""));
    };

    reader.readAsText(file);
    event.target.value = "";
  }

  function attachReferenceFiles(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const supportedFiles = files.filter((file) =>
      ["image/jpeg", "image/png", "application/pdf"].includes(file.type)
    );

    const nextFiles = supportedFiles.map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      type: file.type,
      url: URL.createObjectURL(file),
    }));

    setAttachedFiles((prev) => [...prev, ...nextFiles]);
    event.target.value = "";
  }

  function removeAttachedFile(fileId) {
    setAttachedFiles((prev) => {
      const fileToRemove = prev.find((file) => file.id === fileId);
      if (fileToRemove) URL.revokeObjectURL(fileToRemove.url);
      return prev.filter((file) => file.id !== fileId);
    });
  }

  async function importRows() {
    const filledRows = rows.filter((row) => !isTemplateRowEmpty(row));
    if (filledRows.length === 0) return;

    await onImportRows(template, filledRows);
    setRows(makeTemplateRows(template, 12));
  }

  function saveTitle() {
    const label = titleDraft.trim();
    if (!label) return;

    onRenameTemplate?.(template.id, label);
    setIsEditingTitle(false);
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <header style={headerStyle}>
          <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
            Census template
          </p>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", flexWrap: "wrap", margin: "10px 0 16px" }}>
            {isEditingTitle ? (
              <>
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  style={{ ...inputStyle, fontSize: "26px", fontWeight: "700", minWidth: "280px" }}
                />
                <button onClick={saveTitle} style={buttonStyle}>Save</button>
                <button
                  onClick={() => {
                    setTitleDraft(template.label);
                    setIsEditingTitle(false);
                  }}
                  style={lightButtonStyle}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <h1 style={{ fontSize: "46px", margin: 0 }}>{template.label}</h1>
                {template.custom && (
                  <button
                    onClick={() => setIsEditingTitle(true)}
                    aria-label="Edit template title"
                    title="Edit title"
                    style={{ ...lightButtonStyle, width: "42px", height: "42px", padding: 0, fontSize: "20px" }}
                  >
                    ✎
                  </button>
                )}
              </>
            )}
          </div>
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
          {template.note && (
            <div style={{ background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: "10px", padding: "16px", marginBottom: "18px", color: "#78350f", lineHeight: 1.6, whiteSpace: "pre-line" }}>
              {template.note}
              {template.noteLink && (
                <p style={{ margin: "12px 0 0" }}>
                  {template.noteLink.prefix}
                  <a href={template.noteLink.url} target="_blank" rel="noreferrer" style={{ color: "#92400e", fontWeight: "700" }}>
                    {template.noteLink.label}
                  </a>
                  {template.noteLink.suffix}
                </p>
              )}
            </div>
          )}

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
              <label style={{ ...buttonStyle, display: "inline-block" }}>
                Import CSV
                <input type="file" accept=".csv,.txt" onChange={importCsvFile} style={{ display: "none" }} />
              </label>
              <button onClick={importRows} disabled={!activeProject} style={lightButtonStyle}>Add Filled Rows to Project</button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr)) auto", gap: "8px", alignItems: "center", marginTop: "18px" }}>
            <input
              value={templateFilter.lastName}
              onChange={(event) => setTemplateFilter((prev) => ({ ...prev, lastName: event.target.value }))}
              placeholder="Filter last name"
              style={inputStyle}
            />
            <input
              value={templateFilter.firstName}
              onChange={(event) => setTemplateFilter((prev) => ({ ...prev, firstName: event.target.value }))}
              placeholder="Filter first name"
              style={inputStyle}
            />
            <input
              value={templateFilter.location}
              onChange={(event) => setTemplateFilter((prev) => ({ ...prev, location: event.target.value }))}
              placeholder="Filter location"
              style={inputStyle}
            />
            <button
              onClick={resetTemplateFilter}
              disabled={!hasTemplateFilter}
              aria-label="Reset template filter"
              title="Reset filter"
              style={{
                ...lightButtonStyle,
                width: "42px",
                minHeight: "40px",
                padding: 0,
                color: hasTemplateFilter ? "#dc2626" : "#9ca3af",
                cursor: hasTemplateFilter ? "pointer" : "not-allowed",
              }}
            >
              X
            </button>
          </div>

          <div style={{ marginTop: "18px" }}>
            <textarea
              value={pastedTemplateText}
              onChange={(event) => setPastedTemplateText(event.target.value)}
              placeholder="Paste rows from a spreadsheet here"
              style={{
                ...inputStyle,
                width: "100%",
                minHeight: "96px",
                boxSizing: "border-box",
                fontFamily: "Arial, Helvetica, sans-serif",
              }}
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
              <button onClick={applyPasteBox} disabled={!pastedTemplateText.trim()} style={buttonStyle}>
                Paste Data into Template
              </button>
              <button onClick={() => setPastedTemplateText("")} disabled={!pastedTemplateText} style={lightButtonStyle}>
                Clear Paste Box
              </button>
            </div>
          </div>

          <div style={{ marginTop: "18px" }}>
            <label style={{ ...lightButtonStyle, display: "inline-block" }}>
              Attach Images/PDFs
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
                multiple
                onChange={attachReferenceFiles}
                style={{ display: "none" }}
              />
            </label>

            {attachedFiles.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "10px", marginTop: "12px" }}>
                {attachedFiles.map((file) => (
                  <div key={file.id} style={{ border: "1px solid #e5e7eb", borderRadius: "10px", overflow: "hidden", background: "#f9fafb" }}>
                    {file.type.startsWith("image/") ? (
                      <img
                        src={file.url}
                        alt={file.name}
                        style={{ width: "100%", height: "110px", objectFit: "cover", display: "block" }}
                      />
                    ) : (
                      <div style={{ height: "110px", display: "flex", alignItems: "center", justifyContent: "center", background: "#fee2e2", color: "#991b1b", fontWeight: "700" }}>
                        PDF
                      </div>
                    )}
                    <div style={{ padding: "8px" }}>
                      <div title={file.name} style={{ fontSize: "12px", color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {file.name}
                      </div>
                      <button
                        onClick={() => removeAttachedFile(file.id)}
                        style={{ ...lightButtonStyle, width: "100%", marginTop: "6px", padding: "6px", color: "#dc2626" }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
                {filteredTemplateRows.map(({ row, index: rowIndex }) => (
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
                {filteredTemplateRows.length === 0 && (
                  <tr>
                    <td colSpan={template.columns.length} style={{ padding: "18px", textAlign: "center", color: "#6b7280" }}>
                      No rows match this filter.
                    </td>
                  </tr>
                )}
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
  const [customTemplates, setCustomTemplates] = useState(loadCustomTemplates);
  const [customTemplateDraft, setCustomTemplateDraft] = useState({
    name: "",
    year: "",
    columnsText: "",
  });
  const [timelineSearch, setTimelineSearch] = useState({
    firstName: "",
    lastName: "",
    birth: "",
    location: "",
  });
  const [timelineHasRun, setTimelineHasRun] = useState(false);
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

  useEffect(() => {
    localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(customTemplates));
  }, [customTemplates]);

  const activeProject = data.projects.find((p) => p.id === data.activeProjectId) || data.projects[0];

  const allTemplates = useMemo(() => [...censusTemplates, ...customTemplates], [customTemplates]);

  const templateLinks = useMemo(() => {
    const builtInLinks = censusTemplateYears.map((year) => ({
      id: getTemplateIdForYear(year),
      label: year,
      isCustom: false,
    }));

    const customLinks = customTemplates.map((template) => ({
      id: template.id,
      label: template.year || template.label,
      isCustom: true,
    }));

    return [...builtInLinks, ...customLinks];
  }, [customTemplates]);

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

  const personTimelineResults = useMemo(() => {
    const firstName = timelineSearch.firstName.trim().toLowerCase();
    const lastName = timelineSearch.lastName.trim().toLowerCase();
    const birth = timelineSearch.birth.trim().toLowerCase();
    const location = timelineSearch.location.trim().toLowerCase();

    if (!firstName && !lastName && !birth && !location) return [];

    return allRecords
      .filter((record) => {
        const name = String(record.name || "").toLowerCase();
        const recordLocation = String(record.location || "").toLowerCase();
        const notes = String(record.notes || "").toLowerCase();

        if (firstName && !name.includes(firstName)) return false;
        if (lastName && !name.includes(lastName)) return false;
        if (birth && !notes.includes(birth) && !String(record.year || "").includes(birth)) return false;
        if (location && !recordLocation.includes(location) && !notes.includes(location)) return false;

        return true;
      })
      .sort((a, b) => String(a.year || "").localeCompare(String(b.year || "")));
  }, [allRecords, timelineSearch]);

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

  function saveCustomTemplate() {
    const name = customTemplateDraft.name.trim();
    const year = customTemplateDraft.year.trim();
    const labels = parseColumnLabels(customTemplateDraft.columnsText);

    if (!name || labels.length === 0) {
      window.alert("Add a template name and at least one column header.");
      return;
    }

    const existingKeys = new Set();
    const columns = labels.map((label) => ({
      key: columnKeyFromLabel(label, existingKeys),
      label,
    }));

    const baseId = `custom-${slugifyTemplateId(year || name)}`;
    const existingIds = new Set([...censusTemplates, ...customTemplates].map((template) => template.id));
    let id = baseId || `custom-template-${Date.now()}`;
    let counter = 2;

    while (existingIds.has(id)) {
      id = `${baseId}-${counter}`;
      counter += 1;
    }

    const template = {
      id,
      year,
      label: year ? `${year} ${name}` : name,
      description: "Custom census template.",
      columns,
      custom: true,
    };

    setCustomTemplates((prev) => [...prev, template]);
    setCustomTemplateDraft({ name: "", year: "", columnsText: "" });
    window.location.hash = `#/templates/${id}`;
  }

  function importCustomTemplateCsvHeaders(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const firstLine = String(reader.result || "").split(/\r?\n/).find((line) => line.trim()) || "";
      setCustomTemplateDraft((prev) => ({
        ...prev,
        columnsText: firstLine.split(",").map((label) => label.trim()).filter(Boolean).join("\n"),
      }));
    };

    reader.readAsText(file);
    event.target.value = "";
  }

  function renameCustomTemplate(templateId, label) {
    setCustomTemplates((prev) =>
      prev.map((template) => (template.id === templateId ? { ...template, label } : template))
    );
  }

  function deleteCustomTemplate(templateId, label) {
    const confirmed = window.confirm(`Delete custom template "${label}"? This cannot be undone.`);
    if (!confirmed) return;

    setCustomTemplates((prev) => prev.filter((template) => template.id !== templateId));
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
    marginTop: "12px",
    paddingTop: "4px",
  };

  const helpSectionNoDividerStyle = {
    marginTop: "12px",
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
              <input
                value={customTemplateDraft.name}
                onChange={(event) => setCustomTemplateDraft((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Template name"
                style={inputStyle}
              />
              <input
                value={customTemplateDraft.year}
                onChange={(event) => setCustomTemplateDraft((prev) => ({ ...prev, year: event.target.value }))}
                placeholder="Year"
                style={inputStyle}
              />
            </div>
            <textarea
              value={customTemplateDraft.columnsText}
              onChange={(event) => setCustomTemplateDraft((prev) => ({ ...prev, columnsText: event.target.value }))}
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
              <label style={{ ...lightButtonStyle, display: "inline-block" }}>
                Import CSV Headers
                <input type="file" accept=".csv,.txt" onChange={importCustomTemplateCsvHeaders} style={{ display: "none" }} />
              </label>
              <button onClick={saveCustomTemplate} style={buttonStyle}>Save Template</button>
            </div>
          </section>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage.startsWith("#/templates/")) {
    const templateId = currentPage.replace("#/templates/", "");
    const template = allTemplates.find((candidate) => candidate.id === templateId);
    const templateYear = templateId.replace("us-census-", "");

    if (template) {
      return (
        <CensusTemplatePage
          template={template}
          activeProject={activeProject}
          onImportRows={importTemplateRows}
          onRenameTemplate={renameCustomTemplate}
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
                <a href="#/help/how-it-works" style={{ ...navLinkStyle, textAlign: "left", background: "#f9fafb" }}>
                  <strong>How Census Notebook works</strong>
                  <br />
                  <span style={{ color: "#4b5563", fontWeight: "400" }}>
                    Learn how local storage, projects, searching, and privacy fit together.
                  </span>
                </a>
                <a href="#/help/census-image-text" style={{ ...navLinkStyle, textAlign: "left", background: "#f9fafb" }}>
                  <strong>Converting a census image into text</strong>
                  <br />
                  <span style={{ color: "#4b5563", fontWeight: "400" }}>
                    Download an image, transcribe it with OCR or AI, clean it up, and import it.
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
                  <strong>Using Templates</strong>
                  <br />
                  <span style={{ color: "#4b5563", fontWeight: "400" }}>
                    Paste spreadsheet rows, import CSV files, attach source documents, and save template data.
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

  if (currentPage === "#/analysis/person-timeline") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Analysis
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Person Timeline</h1>
            <a href="#/" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Census Notebook
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Follow one individual across time</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Person Timeline will gather every census entry for one person and line those records up
              chronologically so changes are easier to see.
            </p>

            <section style={helpSectionNoDividerStyle}>
              <h3>Search for a person</h3>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setTimelineHasRun(true);
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: "10px" }}>
                  <input
                    value={timelineSearch.firstName}
                    onChange={(event) => setTimelineSearch((prev) => ({ ...prev, firstName: event.target.value }))}
                    placeholder="First name"
                    style={inputStyle}
                  />
                  <input
                    value={timelineSearch.lastName}
                    onChange={(event) => setTimelineSearch((prev) => ({ ...prev, lastName: event.target.value }))}
                    placeholder="Last name"
                    style={inputStyle}
                  />
                  <input
                    value={timelineSearch.birth}
                    onChange={(event) => setTimelineSearch((prev) => ({ ...prev, birth: event.target.value }))}
                    placeholder="Birth year or date"
                    style={inputStyle}
                  />
                  <input
                    value={timelineSearch.location}
                    onChange={(event) => setTimelineSearch((prev) => ({ ...prev, location: event.target.value }))}
                    placeholder="Location"
                    style={inputStyle}
                  />
                </div>
                <button type="submit" style={{ ...buttonStyle, marginTop: "12px" }}>Analyze</button>
              </form>
            </section>

            {timelineHasRun && (
              <section style={helpSectionStyle}>
                <h3>Results</h3>
                {personTimelineResults.length > 0 ? (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                      <thead>
                        <tr style={{ background: "#f3f4f6" }}>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Year</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Name</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Age</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Location</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Occupation</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Household members</th>
                        </tr>
                      </thead>
                      <tbody>
                        {personTimelineResults.map((record) => (
                          <tr key={`${record.projectId}-${record.id}`}>
                            <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{record.year}</td>
                            <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>{record.name}</td>
                            <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getNoteValue(record.notes, ["Age"]) || "N/A"}</td>
                            <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{record.location || "N/A"}</td>
                            <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getNoteValue(record.notes, ["Occupation", "Usual Occupation", "Prior Occupation"]) || "N/A"}</td>
                            <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{record.household || "N/A"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ color: "#4b5563" }}>No matching records found.</p>
                )}
              </section>
            )}

            <section style={helpSectionNoDividerStyle}>
              <h3>What it will show</h3>
              <ul>
                <li>Every census entry for a person.</li>
                <li>A link from each result to the full household record.</li>
                <li>Key fields side-by-side: age, location, occupation, and household members.</li>
              </ul>
            </section>

            <section style={helpSectionNoDividerStyle}>
              <h3>What it reveals</h3>
              <ul>
                <li>Migration patterns.</li>
                <li>Age inconsistencies.</li>
                <li>Name variations.</li>
              </ul>
            </section>

            <section style={helpSectionNoDividerStyle}>
              <h3>Planned enhancement</h3>
              <p>
                Census Notebook can flag timeline gaps, such as <strong>Missing 1870 census</strong>,
                when expected census years are not represented for a person.
              </p>
            </section>
          </article>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/how-it-works") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>How Census Notebook Works</h1>
            <a href="#/help" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Help
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>A private workspace for census research</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Census Notebook is a simple, private workspace designed to help you organize and explore
              your census records without needing a complex setup or database server.
            </p>

            <section style={helpSectionStyle}>
              <h3>Ways to use it</h3>
              <ul>
                <li>Run it directly in your web browser, with no installation required.</li>
                <li>Or download it as a standalone desktop app for Windows or Mac.</li>
              </ul>
              <p>
                Even though it can run in a browser, your data is not stored in the cloud unless you
                choose to export it yourself.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Your data stays with you</h3>
              <p>Census Notebook stores all your information locally on your device.</p>
              <ul>
                <li>Nothing is automatically uploaded to a server.</li>
                <li>Your research is not shared or tracked.</li>
                <li>You remain in full control of your data.</li>
              </ul>
              <p>This makes it ideal for genealogists who value privacy or want to work offline.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Optional sharing</h3>
              <p>
                By default, your data is completely private. Optional sharing features can give you
                flexibility when you want it.
              </p>
              <ul>
                <li>Export to CSV or JSON to share with another researcher.</li>
                <li>Import data from spreadsheets or shared files.</li>
                <li>Create a read-only copy for collaboration.</li>
              </ul>
              <p>
                This approach keeps your data private by default while still allowing controlled sharing.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Why use Census Notebook?</h3>
              <p>Census Notebook is designed around how genealogists actually work.</p>
              <ul>
                <li>Private, local-first data storage.</li>
                <li>Flexible access in a browser or desktop app.</li>
                <li>Tools to help you see patterns, not just store records.</li>
              </ul>
              <p>Census Notebook gives you a comprehensive way to use your census records.</p>
            </section>
          </article>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/templates") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Using Templates</h1>
            <a href="#/help" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Help
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Using Census Templates</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Census Templates make it easy to enter large amounts of census data quickly and
              consistently. Whether you prefer working in a spreadsheet or typing directly into the
              app, you can choose the method that works best for you.
            </p>

            <section style={helpSectionStyle}>
              <h3>Paste Data from a Spreadsheet</h3>
              <p>If you already have data in a spreadsheet:</p>
              <ul>
                <li>Copy your rows from Excel or another spreadsheet program.</li>
                <li>Paste the data into the paste box.</li>
                <li>Click <strong>Paste Data into Template</strong>.</li>
              </ul>
              <p>The fields in the template are automatically filled and aligned to the correct columns.</p>
              <p>This is the fastest way to bring in structured data.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Import a CSV File</h3>
              <p>You can also import a saved file:</p>
              <ul>
                <li>Click <strong>Import CSV</strong>.</li>
                <li>Navigate to your file.</li>
                <li>Click <strong>Open</strong>.</li>
              </ul>
              <p>The data is loaded directly into the template fields, ready for review and editing.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Enter Data Manually</h3>
              <p>To add data directly in the app:</p>
              <ul>
                <li>Click <strong>Add Rows</strong>.</li>
                <li>Type or paste information into each field.</li>
              </ul>
              <p>This is useful when working from a single census page or handwritten notes.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Editing and Reviewing Data</h3>
              <p>Before saving your data to a project, you can:</p>
              <ul>
                <li>Edit any field.</li>
                <li>Correct spelling or formatting.</li>
                <li>Add or remove rows as needed.</li>
              </ul>
              <p>You are working in a staging area, so nothing is saved until you decide.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Clearing the Template</h3>
              <p>To remove all current data:</p>
              <ul>
                <li>Click <strong>Clear</strong>.</li>
              </ul>
              <p>
                <strong>Warning:</strong> This action cannot be undone. Make sure you want to remove
                all data before proceeding.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Working with Mixed Data</h3>
              <p>You can continue adding records even if they come from:</p>
              <ul>
                <li>Different locations.</li>
                <li>Different households within the same year.</li>
              </ul>
              <p>Use filters to focus your view:</p>
              <ul>
                <li>Filter by name.</li>
                <li>Filter by location.</li>
              </ul>
              <p>This allows you to work flexibly without losing organization.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Saving Data to Your Project</h3>
              <p>When you are satisfied with your entries:</p>
              <ul>
                <li>Click <strong>Add Filled Rows to Project</strong>.</li>
              </ul>
              <p>This saves your data to the selected census year within your project.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Attaching Source Documents</h3>
              <p>For deeper research and verification, you can attach files to a census year:</p>
              <p>Supported formats:</p>
              <ul>
                <li>JPG.</li>
                <li>PNG.</li>
                <li>PDF.</li>
              </ul>
              <p>These attachments let you quickly return to the original census images or documents.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Downloading and Reusing Templates</h3>
              <p>You can export a blank template for use outside the app:</p>
              <ul>
                <li>Download the template for a specific census year.</li>
                <li>Open it in your preferred spreadsheet program.</li>
                <li>Enter your data.</li>
                <li>Copy/paste or import it back into Census Notebook.</li>
              </ul>
              <p>This is especially helpful if you prefer doing data entry offline or in bulk.</p>
            </section>
          </article>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/census-years") {

    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>
              Census Versions Through the Years
            </h1>
            <a href="#/help" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Help
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>How Census Records Changed Over Time</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              The U.S. census became more detailed over time. Each census adds new clues, but also
              new limitations.
            </p>

            <section style={helpSectionStyle}>
              <h3>Quick Overview</h3>
              <ul>
                <li><strong>Before 1850:</strong> Only the head of household is named.</li>
                <li><strong>1850-1870:</strong> Every person is listed, but relationships are unclear.</li>
                <li><strong>1880 and later:</strong> Relationships and richer details appear.</li>
                <li><strong>1900+:</strong> Highly detailed personal and family data appears.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Census Years and What They Tell You</h3>
              <h4>1850 Census</h4>
              <p><strong>What is new:</strong> First census listing every individual by name.</p>
              <p><strong>Fields include:</strong> Name, age, sex, occupation, and birthplace.</p>
              <p><strong>What it can prove:</strong> A person existed in a household at that time, approximate birth year, and location.</p>
              <p><strong>What it cannot prove:</strong> Relationships, exact birth dates, or family structure with certainty.</p>
              <p>You infer relationships based on age and proximity.</p>

              <h4>1860 Census</h4>
              <p>Very similar to 1850, with slight improvements.</p>
              <p><strong>Adds:</strong> Real estate value and personal estate value.</p>
              <p><strong>What it can prove:</strong> Economic status and continued residence.</p>
              <p><strong>Limitations:</strong> Still no explicit relationships.</p>

              <h4>1870 Census</h4>
              <p>Post-Civil War census, and very important for genealogy.</p>
              <p><strong>Adds:</strong> Citizenship for males, voting eligibility, and more consistent recording of formerly enslaved individuals.</p>
              <p><strong>What it can prove:</strong> First appearance of many African Americans by name and legal status after emancipation.</p>
              <p><strong>Limitations:</strong> Still no relationships, and ages are often inconsistent.</p>

              <h4>1880 Census</h4>
              <p><strong>Major turning point:</strong> Relationships are now recorded.</p>
              <p><strong>Adds:</strong> Relationship to head of household, marital status, and parents' birthplaces.</p>
              <p><strong>What it can prove:</strong> Family structure, multi-generational households, and parental origins.</p>
              <p><strong>Limitations:</strong> No full birth dates, and there can still be inconsistencies in ages.</p>

              <h4>1900 Census</h4>
              <p><strong>One of the most valuable:</strong> Huge leap in detail.</p>
              <p><strong>Adds:</strong> Month and year of birth, number of years married, number of children and how many living, immigration year, and citizenship status.</p>
              <p><strong>What it can prove:</strong> More precise birth information, marriage timeline, family completeness, and immigration clues.</p>
              <p><strong>Limitations:</strong> Self-reported data may not be accurate.</p>

              <h4>1910 Census</h4>
              <p>Builds on 1900.</p>
              <p><strong>Adds:</strong> Number of marriages, Civil War veteran status, and employment status.</p>
              <p><strong>What it can prove:</strong> Marriage history and military service clues.</p>
              <p><strong>Limitations:</strong> No exact birth month, only age again.</p>

              <h4>1920 Census</h4>
              <p>Focuses on immigration and citizenship.</p>
              <p><strong>Adds:</strong> Year of immigration, naturalization status, and native language.</p>
              <p><strong>What it can prove:</strong> Immigration timeline and citizenship progress.</p>
              <p><strong>Limitations:</strong> Less family detail than 1900.</p>

              <h4>1930 Census</h4>
              <p>Adds social context.</p>
              <p><strong>Adds:</strong> Age at first marriage, home ownership, radio ownership, and veteran status.</p>
              <p><strong>What it can prove:</strong> Marriage timing, economic status, and lifestyle indicators.</p>

              <h4>1940 Census</h4>
              <p>Very rich for modern genealogy.</p>
              <p><strong>Adds:</strong> Residence in 1935, income, education level, and employment details.</p>
              <p><strong>What it can prove:</strong> Movement over time, economic conditions during the Depression, and education level.</p>

              <h4>1950 Census</h4>
              <p>Even more modern detail.</p>
              <p><strong>Adds:</strong> Detailed employment information, hours worked, income brackets, and expanded sampling questions.</p>
              <p><strong>What it can prove:</strong> Work patterns, economic stability, and household structure in detail.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>What Census Data Can and Cannot Prove</h3>
              <h4>What Census Data Can Prove</h4>
              <ul>
                <li>A person was in a specific place at a specific time.</li>
                <li>Household composition, especially after 1880.</li>
                <li>Approximate birth year.</li>
                <li>Migration patterns.</li>
                <li>Economic and social status.</li>
              </ul>
              <h4>What Census Data Cannot Reliably Prove</h4>
              <ul>
                <li>Exact birth dates, except 1900, and even that can be wrong.</li>
                <li>Exact relationships before 1880.</li>
                <li>Correct spelling of names.</li>
                <li>Consistent ages across years.</li>
              </ul>
              <p>Census data is evidence, not absolute truth.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Why This Matters for Census Notebook</h3>
              <p>This variation is exactly why Census Notebook templates matter:</p>
              <ul>
                <li>Each census year needs a different template structure.</li>
                <li>1850 templates do not need a relationship field.</li>
                <li>1880 templates include relationship.</li>
                <li>1900 templates include birth month and year.</li>
              </ul>
              <p>This is a huge advantage over generic spreadsheets.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Practical Genealogy Insight</h3>
              <p>The real power comes from combining years:</p>
              <ul>
                <li><strong>1850-1870:</strong> Establish presence.</li>
                <li><strong>1880:</strong> Confirm relationships.</li>
                <li><strong>1900:</strong> Refine birth and marriage.</li>
                <li><strong>1920+:</strong> Track immigration and movement.</li>
              </ul>
              <p>No single census tells the full story, but together, they form a timeline.</p>
            </section>
          </article>
          <CopyrightFooter />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/census-image-text") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>
              Converting a Census Image into Text
            </h1>
            <a href="#/help" style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Help
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Getting a Census Image into Census Notebook</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Sometimes you find a census record, such as on FamilySearch, but it is only available
              as an image. To use that data in Census Notebook or a spreadsheet, you need to turn
              that image into text.
            </p>
            <p>This process is called transcription.</p>

            <section style={helpSectionStyle}>
              <h3>Step 1: Download the Census Image</h3>
              <ul>
                <li>Open the census record online, such as from FamilySearch, Ancestry, or state archives.</li>
                <li>Look for a Download button, often an arrow icon.</li>
                <li>Save the image to your computer as a JPG or PNG.</li>
              </ul>
              <p>If there is no download option, take a screenshot of the page instead.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Step 2: Convert the Image to Text</h3>
              <p>
                To avoid typing everything manually, you can use a tool that reads text from images.
                This is called OCR, or Optical Character Recognition.
              </p>
              <p>Simple options:</p>
              <ul>
                <li>Mac: Preview can select text from an image if text recognition is available.</li>
                <li>Windows: Snipping Tool can extract text on newer versions.</li>
                <li>
                  AI tools such as ChatGPT or Google Gemini can transcribe an uploaded image. Upload
                  the image, then use the prompt below.
                </li>
              </ul>
              <p>Upload your image, and the tool will give you editable text.</p>
              <p>
                <strong>Note:</strong> Census images are often handwritten, so OCR may not be
                perfect. You will still need to review and fix errors.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Step 3: Clean Up the Text</h3>
              <p>Open the extracted text and:</p>
              <ul>
                <li>Fix misspelled names.</li>
                <li>Correct numbers, such as ages and years.</li>
                <li>Align the data into columns like Name, Age, Location, and Occupation.</li>
              </ul>
              <p>You do not need to be perfect. Just make it readable and consistent.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Step 4: Move the Data into a Spreadsheet</h3>
              <p>
                Open Census Notebook to the desired Template year, or use Excel or a similar
                spreadsheet app, and:
              </p>
              <ul>
                <li>Paste your cleaned text.</li>
                <li>Arrange it into columns.</li>
                <li>Make sure each person is on their own row.</li>
              </ul>
              <p>Or save the data as a CSV file and click <strong>Import CSV</strong>.</p>
              <p>Your data will automatically fill into the template fields.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Prompt</h3>
              <p>Use this prompt with an AI tool after attaching your census image:</p>
              <code style={codeBlockStyle}>{`Transcribe the attached census image into clean, structured data suitable for a spreadsheet.

Instructions:
- Extract all visible rows of people in the census.
- Output the data in a table format using consistent columns.
- Use one row per person.

Rules:
- Preserve original spelling as written in the image.
- If text is unclear, use [unclear] or best guess with (?) after it.
- Do not skip rows, even if incomplete.
- Keep numbers as numbers (no extra text).
- Do not combine multiple people into one row.
- Ignore page decorations, headers, or unrelated markings.

Formatting:
- Output as CSV (comma-separated values), ready to paste into Excel or import into another app.
- Include a header row.
- Do not include explanations or extra text - only the table.

Optional:
- If household groupings are visible, include a Household ID column.
- If the location is shown (town/county/state), include it for all rows.

Goal:
Produce clean, structured data that can be directly imported into a spreadsheet or genealogy app.`}</code>
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

            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Analysis</h2>
              <a
                href="#/analysis/person-timeline"
                style={{ ...buttonStyle, display: "block", textDecoration: "none", textAlign: "center" }}
              >
                Person Timeline
              </a>
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

            <section id="templates" style={cardStyle}>
              <h2 style={sectionTitleStyle}>Templates</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: "8px" }}>
                {templateLinks.map((template) =>
                  template.isCustom ? (
                    <div key={template.id} style={{ display: "flex", gap: "4px", minWidth: 0 }}>
                      <a
                        href={`#/templates/${template.id}`}
                        style={{ ...navLinkStyle, background: "#f9fafb", padding: "10px", textAlign: "center", flex: 1, minWidth: 0 }}
                      >
                        {template.label}
                      </a>
                      <button
                        onClick={() => deleteCustomTemplate(template.id, template.label)}
                        aria-label={`Delete ${template.label} custom template`}
                        title="Delete custom template"
                        style={{
                          ...lightButtonStyle,
                          width: "34px",
                          padding: 0,
                          color: "#dc2626",
                        }}
                      >
                        X
                      </button>
                    </div>
                  ) : (
                    <a
                      key={template.id}
                      href={`#/templates/${template.id}`}
                      style={{ ...navLinkStyle, background: "#f9fafb", padding: "10px", textAlign: "center" }}
                    >
                      {template.label}
                    </a>
                  )
                )}
              </div>
              <a
                href="#/templates/create"
                style={{ ...buttonStyle, display: "block", marginTop: "12px", textDecoration: "none", textAlign: "center" }}
              >
                Create Template
              </a>
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
