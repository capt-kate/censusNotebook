import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import {
  censusTemplates,
  censusTemplateYears,
  getTemplateIdForYear,
} from "./templates/censusTemplates";

const STORAGE_KEY = "census-notebook-v1";
const CUSTOM_TEMPLATES_KEY = "census-notebook-custom-templates-v1";
const INDEXED_DB_NAME = "census-notebook-local-data";
const INDEXED_DB_STORE = "app-state";
const INDEXED_DB_DATA_KEY = "projects";
const API_ENABLED = import.meta.env.VITE_ENABLE_API === "true";
const emptyData = { activeProjectId: "", projects: [] };

function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadStarterData() {
  const starterDataModule = await import("./starterData.json");
  return starterDataModule.default;
}

function loadLocalStorageData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function openLocalDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available."));
      return;
    }

    const request = indexedDB.open(INDEXED_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INDEXED_DB_STORE)) {
        database.createObjectStore(INDEXED_DB_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readLocalDatabaseData() {
  return new Promise((resolve, reject) => {
    openLocalDatabase()
      .then((database) => {
        const transaction = database.transaction(INDEXED_DB_STORE, "readonly");
        const store = transaction.objectStore(INDEXED_DB_STORE);
        const request = store.get(INDEXED_DB_DATA_KEY);

        request.onsuccess = () => {
          database.close();
          resolve(request.result || null);
        };
        request.onerror = () => {
          database.close();
          reject(request.error);
        };
      })
      .catch(reject);
  });
}

function writeLocalDatabaseData(data) {
  return new Promise((resolve, reject) => {
    openLocalDatabase()
      .then((database) => {
        const transaction = database.transaction(INDEXED_DB_STORE, "readwrite");
        const store = transaction.objectStore(INDEXED_DB_STORE);
        store.put(data, INDEXED_DB_DATA_KEY);

        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      })
      .catch(reject);
  });
}

async function loadStoredData() {
  try {
    const indexedData = await readLocalDatabaseData();
    if (indexedData) return indexedData;

    const localStorageData = loadLocalStorageData();
    const data = localStorageData || await loadStarterData();
    await writeLocalDatabaseData(data);
    localStorage.removeItem(STORAGE_KEY);
    return data;
  } catch {
    return loadLocalStorageData() || await loadStarterData();
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

function sanitizeFilePart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

function getFileExtension(filename) {
  const match = String(filename || "").match(/\.([a-z0-9]+)$/i);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function getHashSearchParams(hash) {
  const queryStart = hash.indexOf("?");
  return new URLSearchParams(queryStart >= 0 ? hash.slice(queryStart) : "");
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
      researchNotes: record.researchNotes || record.research_notes || "",
      bookmarked: Boolean(record.bookmarked),
      highlighted: Boolean(record.highlighted),
    })),
  };
}

function recordToApiPayload(record) {
  const { researchNotes, ...rest } = record;
  return {
    ...rest,
    research_notes: researchNotes || "",
  };
}

function recordChangesToApiPayload(changes) {
  if (!Object.prototype.hasOwnProperty.call(changes, "researchNotes")) return changes;
  const { researchNotes, ...rest } = changes;
  return {
    ...rest,
    research_notes: researchNotes || "",
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

function downloadFile(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCsvValue(value) {
  const text = String(value || "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeTemplateCsv(template) {
  const headerRow = template.columns.map((column) => escapeCsvValue(column.label)).join(",");
  const blankRows = makeTemplateRows(template, 12).map((row) =>
    template.columns.map((column) => escapeCsvValue(row[column.key] || "")).join(",")
  );

  return [headerRow, ...blankRows].join("\r\n");
}

function downloadBlankTemplate(template) {
  const yearOrLabel = sanitizeFilePart(template.year || template.label) || "census";
  downloadFile(`${yearOrLabel}-census-template.csv`, makeTemplateCsv(template), "text/csv;charset=utf-8");
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

function normalizeFieldLabel(label) {
  return String(label || "").trim().replace(/\s+/g, " ").toLowerCase();
}

const HIDDEN_PROJECT_DATA_FIELD_LABELS = new Set(
  [
    "Free white males 16+",
    "Free white males under 16",
    "Free white females",
    "TOTAL",
    "Family",
    "Free White Persons - Males Under 10",
    "Free White Persons - Males 10 to 15",
    "Free White Persons - Males 16 to 25",
    "Free White Persons - Males 26 to 44",
    "Free White Persons - Males Over 45",
    "Free White Persons - Females Under 10",
    "Free White Persons - Females 10 to 15",
    "Free White Persons - Females 16 to 25",
    "Free White Persons - Females 26 to 44",
    "Free White Persons - Females Over 45",
    "# Engaged in Agriculture",
    "Total Free White Persons",
    "Males Under 5",
    "Males 5 to under 10",
    "Males 10 to under 15",
    "Males 15 to under 20",
    "Males 20 to under 30",
    "Males 30 to under 40",
    "Males 40 to under 50",
    "Males 50 to under 60",
    "Males 60 to under 70",
    "Males 70 to under 80",
    "Females 5 to under 10",
    "Females 10 to under 15",
    "Females 15 to under 20",
    "Females 20 to under 30",
    "Females 30 to under 40",
    "Females 40 to under 50",
    "Females 50 to under 60",
    "Females 60 to under 70",
    "Real Estate Value",
    "Personal Estate Value",
    "Veteran",
    "Seeking Work",
    "Quest #",
    "Occupation Category",
    "Worked Last Week",
    "Employment Status",
    "Hours Worked",
    "Worker Class",
    "Same House",
    "School Attendance",
    "Weeks Worked",
    "Income Last Year",
    "Other Income",
    "Supplemental Income",
  ].map(normalizeFieldLabel)
);

const HOME_SEARCH_RESULT_LIMIT = 200;
const PROJECT_RECORD_RENDER_LIMIT = 300;
const DUPLICATE_BUCKET_LIMIT = 250;
const recordMetaCache = new WeakMap();

function getRecordDetailFieldEntries(record) {
  const meta = recordMetaCache.get(record);
  if (meta?.detailEntries) return meta.detailEntries;

  return [record.household, record.notes]
    .flatMap((value) => String(value || "").split(";"))
    .map((part) => {
      const separatorIndex = part.indexOf(":");
      if (separatorIndex === -1) return null;

      const label = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      return label && value ? { label, value } : null;
    })
    .filter(Boolean);
}

function getRecordDetailFieldValue(record, label) {
  return getRecordMeta(record).detailMap.get(String(label || "").toLowerCase())?.value || "";
}

function updateRecordDetailFields(record, detailFields) {
  const pendingFields = new Map(
    Object.values(detailFields || {}).map((field) => [
      normalizeFieldLabel(field.label),
      { label: field.label, value: String(field.value || "").trim() },
    ])
  );
  const handledKeys = new Set();

  const updateText = (text) =>
    String(text || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf(":");
        if (separatorIndex === -1) return part;

        const label = part.slice(0, separatorIndex).trim();
        const key = normalizeFieldLabel(label);
        const field = pendingFields.get(key);
        if (!field) return part;

        handledKeys.add(key);
        return field.value ? `${label}: ${field.value}` : "";
      })
      .filter(Boolean)
      .join("; ");

  const household = updateText(record.household);
  const noteParts = updateText(record.notes)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  pendingFields.forEach((field, key) => {
    if (!handledKeys.has(key) && field.value) {
      noteParts.push(`${field.label}: ${field.value}`);
    }
  });

  return {
    household,
    notes: noteParts.join("; "),
  };
}

function updateNoteValue(notes, labels, fallbackLabel, value) {
  const cleanedValue = String(value || "").trim();
  const lowerLabels = labels.map((label) => label.toLowerCase());
  const parts = String(notes || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  let didUpdate = false;

  const updatedParts = parts
    .map((part) => {
      const separatorIndex = part.indexOf(":");
      if (separatorIndex === -1) return part;

      const label = part.slice(0, separatorIndex).trim();
      if (!lowerLabels.includes(label.toLowerCase())) return part;

      didUpdate = true;
      return cleanedValue ? `${label}: ${cleanedValue}` : "";
    })
    .filter(Boolean);

  if (!didUpdate && cleanedValue) {
    updatedParts.push(`${fallbackLabel}: ${cleanedValue}`);
  }

  return updatedParts.join("; ");
}

function getRecordDetail(record, labels) {
  return getNoteValue(`${record.notes || ""}; ${record.household || ""}`, labels);
}

function getRecordDwellingNumber(record) {
  return getRecordMeta(record).dwelling;
}

function getRecordFamilyNumber(record) {
  return getRecordMeta(record).family;
}

function getRecordPageNumber(record) {
  return getRecordMeta(record).page;
}

function getRecordLineNumber(record) {
  return getRecordMeta(record).line;
}

function getRecordBirthYear(record) {
  return getRecordMeta(record).birth;
}

function getRecordSurname(record) {
  return getRecordMeta(record).surname;
}

function getRecordMeta(record) {
  const cachedMeta = recordMetaCache.get(record);
  if (cachedMeta?.complete) return cachedMeta;

  const detailEntries = [record.household, record.notes]
    .flatMap((value) => String(value || "").split(";"))
    .map((part) => {
      const separatorIndex = part.indexOf(":");
      if (separatorIndex === -1) return null;

      const label = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      return label && value ? { label, value } : null;
    })
    .filter(Boolean);
  const detailMap = new Map();

  detailEntries.forEach((entry) => {
    const key = entry.label.toLowerCase();
    if (!detailMap.has(key)) detailMap.set(key, entry);
  });

  const detailValue = (labels) =>
    labels
      .map((label) => detailMap.get(String(label || "").toLowerCase())?.value || "")
      .find(Boolean) || "";
  const surname = detailValue(["Surname", "Last Name"]) || String(record.name || "").trim().split(/\s+/).filter(Boolean).at(-1) || "";
  const name = String(record.name || "").trim();
  const givenName =
    detailValue(["Given Name", "First Name"]) ||
    (surname && name.toLowerCase().endsWith(surname.toLowerCase())
      ? name.slice(0, -surname.length).trim()
      : name);
  const page = detailValue(["Page", "Page Number", "Page #"]);
  const line = detailValue(["Line", "Line Number", "Line #"]);
  const dwelling = detailValue([
    "Dwelling Number",
    "Dwelling #",
    "Number of Dwelling in Order of Visitation",
    "Dwelling in Order of Visitation",
  ]);
  const family = detailValue(["Family", "Family Number", "Family #"]);
  const birth = detailValue(["Birth Year", "Birth", "Estimated Birth Year", "Year of Birth"]);
  const age = detailValue(["Age"]);
  const searchText = [
    record.name,
    givenName,
    surname,
    `${givenName} ${surname}`,
    `${surname} ${givenName}`,
    record.location,
    record.household,
    record.notes,
    record.researchNotes,
  ]
    .join(" ")
    .toLowerCase();
  const matchProfile = {
    year: normalizeMatchText(record.year),
    name: normalizeMatchText(record.name),
    givenName: normalizeMatchText(givenName),
    surname: normalizeMatchText(surname),
    location: normalizeMatchText(record.location),
    page: normalizeMatchText(page),
    line: normalizeMatchText(line),
    dwelling: normalizeMatchText(dwelling),
    family: normalizeMatchText(family),
    age: normalizeMatchText(age),
    birth: normalizeMatchText(birth),
  };
  const meta = {
    complete: true,
    detailEntries,
    detailMap,
    givenName,
    surname,
    page,
    line,
    dwelling,
    family,
    birth,
    age,
    searchText,
    matchProfile,
  };

  recordMetaCache.set(record, meta);
  return meta;
}

function recordMatchesTextFilter(record, filterText) {
  const queryTerms = String(filterText || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) return true;

  return queryTerms.every((term) => getRecordMeta(record).searchText.includes(term));
}

function normalizeMatchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getRecordMatchProfile(record) {
  return getRecordMeta(record).matchProfile;
}

function getDuplicateConfidence(leftRecord, rightRecord) {
  const left = getRecordMatchProfile(leftRecord);
  const right = getRecordMatchProfile(rightRecord);
  if (!left.name || !right.name) return "";

  const sameYear = left.year && left.year === right.year;
  const sameName = left.name === right.name;
  const sameLocation = left.location && left.location === right.location;
  const samePage = left.page && left.page === right.page;
  const sameLine = left.line && left.line === right.line;
  const sameDwelling = left.dwelling && left.dwelling === right.dwelling;
  const sameFamily = left.family && left.family === right.family;
  const sameSurname = left.surname && left.surname === right.surname;
  const sameGivenName = left.givenName && left.givenName === right.givenName;
  const similarName =
    sameName ||
    (sameSurname && sameGivenName) ||
    (sameSurname && left.givenName && right.givenName && left.givenName[0] === right.givenName[0]);
  const sameAgeOrBirth = (left.age && left.age === right.age) || (left.birth && left.birth === right.birth);

  if (
    sameYear &&
    sameName &&
    sameLocation &&
    ((samePage && sameLine) || sameDwelling || sameFamily)
  ) {
    return "Exact";
  }

  if (sameYear && similarName && sameLocation && (samePage || sameDwelling || sameFamily || sameAgeOrBirth)) {
    return "Likely";
  }

  if (similarName && (sameYear || sameLocation || sameAgeOrBirth)) {
    return "Possible";
  }

  return "";
}

function getRecordDwellingOrFamilyKey(record) {
  const dwellingNumber = getRecordDwellingNumber(record);
  const familyNumber = getRecordFamilyNumber(record);
  if (dwellingNumber) return `dwelling-${dwellingNumber}`;
  if (familyNumber) return `family-${familyNumber}`;
  return `record-${record.id}`;
}

function compareRecordValues(leftValue, rightValue, direction = "asc") {
  const modifier = direction === "desc" ? -1 : 1;
  const left = String(leftValue || "").trim();
  const right = String(rightValue || "").trim();

  if (!left && right) return 1;
  if (left && !right) return -1;

  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }) * modifier;
}

function getRecordRelationship(record) {
  return getRecordDetail(record, [
    "Relationship",
    "Relation to Head",
    "Relation to Head of House",
    "Relation to Head of Household",
  ]);
}

function isHeadOfHousehold(record) {
  const relationship = getRecordRelationship(record).trim().toLowerCase();
  return relationship === "head" || relationship === "self" || relationship.includes("head");
}

function getRecordHouseholdKey(record) {
  return [
    record.projectId,
    record.year,
    String(record.location || "").trim().toLowerCase(),
    getRecordDwellingOrFamilyKey(record) || record.household || record.id,
  ].join("|");
}

function HelpIconLink() {
  return (
    <a
      className="no-print"
      href="#/help"
      aria-label="Open Help"
      title="Help"
      style={{
        position: "fixed",
        top: "14px",
        left: "14px",
        zIndex: 20,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "34px",
        height: "34px",
        borderRadius: "50%",
        background: "#ffffff",
        border: "1px solid #d1d5db",
        color: "#2f4473",
        fontSize: "20px",
        fontWeight: "800",
        lineHeight: 1,
        textDecoration: "none",
        boxShadow: "0 8px 20px rgba(15, 23, 42, 0.16)",
      }}
    >
      ?
    </a>
  );
}

function CopyrightFooter({ actionMessage = "" }) {
  const currentHash = window.location.hash || "#/";
  const isHelpPage = currentHash === "#/help" || currentHash.startsWith("#/help/");

  return (
    <>
      {!isHelpPage && <HelpIconLink />}
      {actionMessage && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            top: "16px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            background: "#111827",
            color: "white",
            borderRadius: "999px",
            padding: "8px 14px",
            fontSize: "13px",
            fontWeight: "700",
            boxShadow: "0 10px 25px rgba(15, 23, 42, 0.22)",
          }}
        >
          {actionMessage}
        </div>
      )}
      <footer style={{ marginTop: "24px", padding: "18px", textAlign: "center", color: "#6b7280", fontSize: "14px" }}>
        Copyright {new Date().getFullYear()}{" "}
        <a href="mailto:cousin.kate@olddeadrelatives.com" style={{ color: "inherit", fontWeight: "700" }}>
          Kate Montressor
        </a>
        . v1.2. All rights reserved. This app is free for anyone to use. Please do not steal my work.
      </footer>
    </>
  );
}

function CensusTemplatePage({
  template,
  activeProject,
  onImportRows,
  onRenameTemplate,
  onViewRecordsByYear,
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
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(template.label);
  const [selectedRowIndexes, setSelectedRowIndexes] = useState(() => new Set());
  const [lastSelectedRowIndex, setLastSelectedRowIndex] = useState(null);
  const compactButtonStyle = { ...buttonStyle, fontSize: "13px", padding: "8px 12px" };
  const compactLightButtonStyle = { ...lightButtonStyle, fontSize: "13px", padding: "8px 12px" };

  function updateCell(rowIndex, columnKey, value) {
    setRows((prev) =>
      prev.map((row, index) => (index === rowIndex ? { ...row, [columnKey]: value } : row))
    );
  }

  function addBlankRows() {
    setRows((prev) => [...prev, ...makeBlankTemplateRows(template, 5)]);
  }

  function selectRow(rowIndex, event) {
    setSelectedRowIndexes((prev) => {
      if (event?.shiftKey && lastSelectedRowIndex !== null) {
        const start = Math.min(lastSelectedRowIndex, rowIndex);
        const end = Math.max(lastSelectedRowIndex, rowIndex);
        return new Set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
      }

      if (event?.metaKey || event?.ctrlKey) {
        const next = new Set(prev);
        if (next.has(rowIndex)) {
          next.delete(rowIndex);
        } else {
          next.add(rowIndex);
        }
        return next;
      }

      return new Set([rowIndex]);
    });
    setLastSelectedRowIndex(rowIndex);
  }

  function removeSelectedRows() {
    if (selectedRowIndexes.size === 0) return;

    setRows((prev) => {
      const next = prev.filter((_, rowIndex) => !selectedRowIndexes.has(rowIndex));
      return next.length > 0 ? next : makeBlankTemplateRows(template, 1);
    });
    setSelectedRowIndexes(new Set());
    setLastSelectedRowIndex(null);
  }

  function clearRows() {
    const confirmed = window.confirm("Clear all pasted data from this template?");
    if (confirmed) {
      setRows(makeTemplateRows(template, 12));
      setSelectedRowIndexes(new Set());
      setLastSelectedRowIndex(null);
    }
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
    <div style={{ ...pageStyle, padding: "12px" }}>
      <div style={{ ...shellStyle, maxWidth: "none", margin: 0 }}>
        <header style={{ ...headerStyle, padding: "20px", marginBottom: "12px", textAlign: "left" }}>
          <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
            Census template
          </p>
          <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", gap: "10px", flexWrap: "wrap", margin: "10px 0 16px" }}>
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
          <div style={{ display: "flex", justifyContent: "flex-start", gap: "10px", flexWrap: "wrap" }}>
            <a href="#/" style={{ ...compactButtonStyle, display: "inline-block", textDecoration: "none" }}>
              Back to Home
            </a>
            <button
              type="button"
              onClick={() => downloadBlankTemplate(template)}
              style={compactLightButtonStyle}
            >
              Download blank template
            </button>
          </div>
        </header>

        <section style={{ ...cardStyle, padding: "12px", marginBottom: "12px" }}>
          {template.note && (
            <div style={{ background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: "10px", padding: "16px", marginBottom: "18px", color: "#78350f", lineHeight: 1.6, textAlign: "left", whiteSpace: "pre-line" }}>
              <h3 style={{ margin: "0 0 8px", color: "#78350f", fontSize: "18px" }}>
                About the {template.year} Census
              </h3>
              <p style={{ margin: 0 }}>
                {template.note}
              </p>
              {template.noteItems && (
                <ul style={{ margin: "8px 0 0", paddingLeft: "22px" }}>
                  {template.noteItems.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
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

          {template.topInfo?.length > 0 && (
            <div style={{ marginBottom: "12px", color: "#111827", fontSize: "13px", lineHeight: 1.45 }}>
              {template.topInfo.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", flexDirection: "column" }}>
            <div>
              <h2 style={{ margin: 0 }}>Paste or enter census rows</h2>
              <p style={{ color: "#4b5563", margin: "6px 0 0" }}>
                Import target: {activeProject?.name || "select or create a project first"}
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-start" }}>
              <button onClick={addBlankRows} style={compactLightButtonStyle}>Add Rows</button>
              <button
                onClick={removeSelectedRows}
                disabled={selectedRowIndexes.size === 0}
                style={selectedRowIndexes.size > 0 ? compactLightButtonStyle : { ...compactLightButtonStyle, cursor: "not-allowed", opacity: 0.55 }}
              >
                Remove Rows
              </button>
              <button onClick={clearRows} style={compactLightButtonStyle}>Clear All</button>
              <label style={{ ...compactLightButtonStyle, display: "inline-block" }}>
                Import CSV
                <input type="file" accept=".csv,.txt" onChange={importCsvFile} style={{ display: "none" }} />
              </label>
            </div>
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
              <button onClick={applyPasteBox} disabled={!pastedTemplateText.trim()} style={compactButtonStyle}>
                Paste Data into Template
              </button>
              <button
                onClick={importRows}
                disabled={!activeProject}
                style={activeProject ? compactButtonStyle : { ...compactButtonStyle, cursor: "not-allowed", opacity: 0.55 }}
              >
                Add Filled Rows to Project
              </button>
              <a
                href="#/records-by-year"
                onClick={() => onViewRecordsByYear(template.year)}
                style={{ ...compactLightButtonStyle, display: "inline-block", textDecoration: "none" }}
              >
                View Census Records by Year
              </a>
            </div>
          </div>

          <div style={{ overflow: "auto", marginTop: "12px", border: "1px solid #e5e7eb", borderRadius: "8px" }}>
            <table style={{ borderCollapse: "collapse", minWidth: `${Math.max(760, template.columns.length * 104)}px`, width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  <th
                    style={{
                      position: "sticky",
                      top: 0,
                      left: 0,
                      zIndex: 2,
                      background: "#f3f4f6",
                      borderBottom: "1px solid #d1d5db",
                      borderRight: "1px solid #e5e7eb",
                      padding: "7px",
                      textAlign: "center",
                      whiteSpace: "nowrap",
                      width: "44px",
                    }}
                  >
                    Row
                  </th>
                  {template.columns.map((column) => (
                    <th
                      key={column.key}
                      style={{
                        position: "sticky",
                        top: 0,
                        background: "#f3f4f6",
                        borderBottom: "1px solid #d1d5db",
                        borderRight: "1px solid #e5e7eb",
                        padding: "7px",
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
                  <tr key={rowIndex} style={{ background: selectedRowIndexes.has(rowIndex) ? "#eff6ff" : "white" }}>
                    <td style={{ borderBottom: "1px solid #f3f4f6", borderRight: "1px solid #e5e7eb", padding: 0, background: selectedRowIndexes.has(rowIndex) ? "#dbeafe" : "#f9fafb" }}>
                      <button
                        type="button"
                        onClick={(event) => selectRow(rowIndex, event)}
                        aria-pressed={selectedRowIndexes.has(rowIndex)}
                        aria-label={`Select row ${rowIndex + 1}`}
                        style={{
                          width: "100%",
                          height: "100%",
                          minHeight: "34px",
                          border: "none",
                          background: "transparent",
                          color: selectedRowIndexes.has(rowIndex) ? "#1d4ed8" : "#4b5563",
                          cursor: "pointer",
                          fontWeight: "700",
                        }}
                      >
                        {rowIndex + 1}
                      </button>
                    </td>
                    {template.columns.map((column, columnIndex) => (
                      <td key={column.key} style={{ borderBottom: "1px solid #f3f4f6", borderRight: "1px solid #f3f4f6", padding: 0 }}>
                        <input
                          value={row[column.key]}
                          onChange={(event) => updateCell(rowIndex, column.key, event.target.value)}
                          onMouseDown={(event) => selectRow(rowIndex, event)}
                          onFocus={() => {
                            if (selectedRowIndexes.size === 0) selectRow(rowIndex);
                          }}
                          onPaste={(event) => handlePaste(event, rowIndex, columnIndex)}
                          style={{
                            ...inputStyle,
                            width: "100%",
                            minWidth: "84px",
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

function SourceImageCollectionPage({
  pageStyle,
  shellStyle,
  headerStyle,
  cardStyle,
  buttonStyle,
  lightButtonStyle,
  inputStyle,
}) {
  const [sourceDirectoryHandle, setSourceDirectoryHandle] = useState(null);
  const [sourceDirectoryName, setSourceDirectoryName] = useState("");
  const [sourceDetails, setSourceDetails] = useState({
    year: "",
    state: "",
    county: "",
    town: "",
    surname: "",
    givenName: "",
  });
  const [collectedFiles, setCollectedFiles] = useState([]);
  const collectedFilesRef = useRef([]);

  const sourcePathParts = [
    sourceDetails.year,
    sourceDetails.state,
    sourceDetails.county,
    sourceDetails.town,
  ]
    .map(sanitizeFilePart)
    .filter(Boolean);
  const suggestedSourcePath = sourcePathParts.length > 0 ? sourcePathParts.join(" / ") : "Year / State / County / Town";
  const sourceFilenameBase =
    [
      sourceDetails.year,
      sourceDetails.state,
      sourceDetails.county,
      sourceDetails.town,
      sourceDetails.surname,
      sourceDetails.givenName,
    ]
      .map(sanitizeFilePart)
      .filter(Boolean)
      .join("-") || "census-source";

  useEffect(() => {
    collectedFilesRef.current = collectedFiles;
  }, [collectedFiles]);

  useEffect(() => {
    return () => {
      collectedFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url));
    };
  }, []);

  function updateSourceDetail(field, value) {
    setSourceDetails((prev) => ({ ...prev, [field]: value }));
  }

  async function chooseSourcesFolder() {
    if (!window.showDirectoryPicker) {
      window.alert("Your browser does not support choosing a local folder. Use Chrome or Edge on HTTPS or localhost.");
      return;
    }

    try {
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      setSourceDirectoryHandle(directoryHandle);
      setSourceDirectoryName(directoryHandle.name);
    } catch (error) {
      if (error?.name !== "AbortError") {
        window.alert("Census Notebook could not use that folder.");
      }
    }
  }

  async function getTargetSourceDirectory() {
    if (!sourceDirectoryHandle) return null;

    let directoryHandle = sourceDirectoryHandle;
    for (const part of sourcePathParts) {
      directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: true });
    }

    return directoryHandle;
  }

  async function getAvailableSourceFilename(directoryHandle, file, usedNames) {
    const extension = getFileExtension(file.name) || (file.type === "application/pdf" ? ".pdf" : ".jpg");
    let candidateName = `${sourceFilenameBase}${extension}`;
    let counter = 2;

    while (usedNames.has(candidateName) || await directoryHandle.getFileHandle(candidateName).then(() => true).catch(() => false)) {
      candidateName = `${sourceFilenameBase}-${counter}${extension}`;
      counter += 1;
    }

    usedNames.add(candidateName);
    return candidateName;
  }

  async function copyFileToSourcesFolder(directoryHandle, file, savedName) {
    const fileHandle = await directoryHandle.getFileHandle(savedName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
  }

  async function collectSourceFiles(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    if (!sourceDirectoryHandle) {
      window.alert("Choose a Sources folder before attaching files so Census Notebook can copy and rename them.");
      event.target.value = "";
      return;
    }

    const supportedFiles = files.filter((file) =>
      ["image/jpeg", "image/png", "application/pdf"].includes(file.type)
    );
    const targetDirectory = await getTargetSourceDirectory();
    const usedNames = new Set(collectedFiles.map((file) => file.savedName || file.name));
    const nextFiles = [];

    for (const file of supportedFiles) {
      try {
        const savedName = await getAvailableSourceFilename(targetDirectory, file, usedNames);
        await copyFileToSourcesFolder(targetDirectory, file, savedName);
        nextFiles.push({
          id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          savedName,
          savedPath: [sourceDirectoryName, ...sourcePathParts, savedName].filter(Boolean).join(" / "),
          type: file.type,
          url: URL.createObjectURL(file),
        });
      } catch {
        window.alert(`Census Notebook could not copy ${file.name} to the selected Sources folder.`);
      }
    }

    setCollectedFiles((prev) => [...prev, ...nextFiles]);
    event.target.value = "";
  }

  function removeCollectedFile(fileId) {
    setCollectedFiles((prev) => {
      const fileToRemove = prev.find((file) => file.id === fileId);
      if (fileToRemove) URL.revokeObjectURL(fileToRemove.url);
      return prev.filter((file) => file.id !== fileId);
    });
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <header style={headerStyle}>
          <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
            Sources
          </p>
          <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Collect Census Images</h1>
          <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
            </a>
            <a href="#/help/sources-attachments" style={{ ...lightButtonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Sources & Attachments Help
            </a>
          </div>
        </header>

        <main style={{ maxWidth: "980px", margin: "0 auto", textAlign: "left" }}>
          <section style={cardStyle}>
            <p style={{ margin: "0 0 12px", color: "#4b5563", lineHeight: 1.6 }}>
              Use this page to choose a local Sources folder, enter the census year and location,
              then copy census images or PDFs into that folder with a consistent filename.
            </p>
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px", color: "#374151" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <div style={{ fontSize: "13px" }}>
                  <strong>Folder pattern:</strong>{" "}
                  <code style={{ background: "#eef2ff", color: "#374151", padding: "3px 6px", borderRadius: "6px" }}>
                    Sources / Year / State / County / Town
                  </code>
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button onClick={chooseSourcesFolder} style={lightButtonStyle}>
                    Choose Sources Folder
                  </button>
                  <label style={{ ...lightButtonStyle, display: "inline-block", fontSize: "13.3333px" }}>
                    Attach Images/PDFs
                    <input
                      type="file"
                      accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
                      multiple
                      onChange={collectSourceFiles}
                      style={{ display: "none" }}
                    />
                  </label>
                </div>
              </div>
              <p style={{ margin: "10px 0 0", fontSize: "13px", color: "#4b5563" }}>
                Images and PDFs are saved locally in the Sources folder you designate. They are not uploaded to Census Notebook or the cloud.
              </p>
              <p style={{ margin: "10px 0 0", fontSize: "13px" }}>
                Sources folder: <strong>{sourceDirectoryName || "not selected"}</strong>
              </p>
              <p style={{ margin: "6px 0 0", fontSize: "13px" }}>
                Suggested path: <code style={{ background: "#eef2ff", padding: "2px 6px", borderRadius: "6px" }}>{suggestedSourcePath}</code>
              </p>
              <p style={{ margin: "6px 0 0", fontSize: "13px" }}>
                Suggested filename: <code style={{ background: "#eef2ff", padding: "2px 6px", borderRadius: "6px" }}>{sourceFilenameBase}</code>
              </p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px", marginTop: "14px" }}>
              {[
                ["year", "Year"],
                ["state", "State"],
                ["county", "County"],
                ["town", "Town"],
                ["surname", "Surname"],
                ["givenName", "Given name"],
              ].map(([field, label]) => (
                <label key={field} style={{ display: "flex", flexDirection: "column", gap: "5px", color: "#374151", fontWeight: "700", fontSize: "13px" }}>
                  {label}
                  <input
                    value={sourceDetails[field]}
                    onChange={(event) => updateSourceDetail(field, event.target.value)}
                    style={inputStyle}
                  />
                </label>
              ))}
            </div>

            <div style={{ marginTop: "12px", color: "#4b5563", fontSize: "14px", lineHeight: 1.6 }}>
              <p style={{ margin: 0 }}>
                These fields are used to build the folder path and filename for the census image or PDF you are saving.
              </p>
              <p style={{ margin: "8px 0 0" }}>
                Example: entering <strong>1920</strong>, <strong>Maine</strong>, <strong>Cumberland</strong>,{" "}
                <strong>Falmouth</strong>, <strong>Smith</strong>, and <strong>John</strong> creates a suggested path like{" "}
                <code style={{ background: "#eef2ff", padding: "2px 6px", borderRadius: "6px" }}>
                  Sources / 1920 / Maine / Cumberland / Falmouth
                </code>{" "}
                and a filename like{" "}
                <code style={{ background: "#eef2ff", padding: "2px 6px", borderRadius: "6px" }}>
                  1920_Maine_Cumberland_Falmouth_Smith_John
                </code>
                .
              </p>
              <p style={{ margin: "8px 0 0" }}>
                This makes your source files easier to find later outside the app.
              </p>
              <p style={{ margin: "8px 0 0" }}>
                Leave any field blank if you do not want to include that value in the folder path or filename.
              </p>
            </div>

            {collectedFiles.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "10px", marginTop: "16px" }}>
                {collectedFiles.map((file) => (
                  <div key={file.id} style={{ border: "1px solid #e5e7eb", borderRadius: "10px", overflow: "hidden", background: "#f9fafb" }}>
                    {file.type.startsWith("image/") ? (
                      <img
                        src={file.url}
                        alt={file.name}
                        style={{ width: "100%", height: "120px", objectFit: "cover", display: "block" }}
                      />
                    ) : (
                      <div style={{ height: "120px", display: "flex", alignItems: "center", justifyContent: "center", background: "#fee2e2", color: "#991b1b", fontWeight: "700" }}>
                        PDF
                      </div>
                    )}
                    <div style={{ padding: "8px" }}>
                      <div title={file.savedName} style={{ fontSize: "12px", color: "#047857", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: "700" }}>
                        {file.savedName}
                      </div>
                      <div title={file.savedPath} style={{ fontSize: "12px", color: "#4b5563", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "4px" }}>
                        {file.savedPath}
                      </div>
                      <button
                        onClick={() => removeCollectedFile(file.id)}
                        style={{ ...lightButtonStyle, width: "100%", marginTop: "6px", padding: "6px", color: "#dc2626" }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
        <CopyrightFooter />
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(() => loadLocalStorageData() || emptyData);
  const [dataStorageReady, setDataStorageReady] = useState(API_ENABLED);
  const [currentPage, setCurrentPage] = useState(window.location.hash || "#/");
  const [apiConnected, setApiConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Loading your local data...");
  const [recordActionMessage, setRecordActionMessage] = useState("");
  const [recordNotesDrafts, setRecordNotesDrafts] = useState({});
  const [query, setQuery] = useState("");
  const [yearFilter, setYearFilter] = useState("all");
  const [showBookmarkedOnly, setShowBookmarkedOnly] = useState(false);
  const [searchResultsCleared, setSearchResultsCleared] = useState(false);
  const [searchResultLimit, setSearchResultLimit] = useState(HOME_SEARCH_RESULT_LIMIT);
  const [recordsByYearSelection, setRecordsByYearSelection] = useState("");
  const [recordsByYearFilter, setRecordsByYearFilter] = useState("");
  const [recordsByYearSort, setRecordsByYearSort] = useState({
    field: "page",
    direction: "asc",
  });
  const [recordsByYearLimit, setRecordsByYearLimit] = useState(PROJECT_RECORD_RENDER_LIMIT);
  const [projectDataFilter, setProjectDataFilter] = useState("");
  const [projectDataSort, setProjectDataSort] = useState({
    field: "surname",
    direction: "asc",
  });
  const [projectRecordLimits, setProjectRecordLimits] = useState({});
  const [selectedProjectRecordIds, setSelectedProjectRecordIds] = useState([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [mergeTargetProjectId, setMergeTargetProjectId] = useState("");
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
  const [neighborsSearch, setNeighborsSearch] = useState({
    lastName: "",
    firstName: "",
    birth: "",
    location: "",
  });
  const [neighborsHasRun, setNeighborsHasRun] = useState(false);
  const [householdSearch, setHouseholdSearch] = useState({
    lastName: "",
    firstName: "",
    birth: "",
    location: "",
  });
  const [householdHasRun, setHouseholdHasRun] = useState(false);
  const [helpSearch, setHelpSearch] = useState("");
  const [editingSearchRecordId, setEditingSearchRecordId] = useState("");
  const [editingSearchRecordDraft, setEditingSearchRecordDraft] = useState({
    year: "",
    name: "",
    birthYear: "",
    location: "",
    household: "",
    notes: "",
    detailFields: {},
  });
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
      if (!API_ENABLED) {
        const storedData = await loadStoredData();
        if (cancelled) return;

        setData(storedData);
        setApiConnected(false);
        setDataStorageReady(true);
        setStatusMessage("Your data is stored locally on this device.");
        return;
      }

      try {
        const projects = await api.fetchProjects();
        if (cancelled) return;

        setData((prev) => toData(projects, prev.activeProjectId));
        setApiConnected(true);
        setStatusMessage("Connected to your private data service.");
      } catch {
        if (cancelled) return;

        setApiConnected(false);
        setDataStorageReady(true);
        setStatusMessage("Your data is stored locally on this device.");
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
    if (!apiConnected && dataStorageReady) {
      writeLocalDatabaseData(data).catch(() => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch {
          setStatusMessage("Local storage is full. Export a backup before adding more records.");
        }
      });
    }
  }, [apiConnected, data, dataStorageReady]);

  useEffect(() => {
    if (!currentPage.startsWith("#/project-data")) return;

    const recordId = getHashSearchParams(currentPage).get("record");
    if (!recordId) return;

    window.setTimeout(() => {
      document.getElementById(`record-${recordId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 0);
  }, [currentPage, data.projects]);

  useEffect(() => {
    localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(customTemplates));
  }, [customTemplates]);

  const activeProject = data.projects.find((p) => p.id === data.activeProjectId) || data.projects[0];
  const mergeTargetProjects = data.projects.filter((project) => project.id !== activeProject?.id);
  const validMergeTargetProjectId = mergeTargetProjects.some((project) => project.id === mergeTargetProjectId)
    ? mergeTargetProjectId
    : "";
  const currentNotesParams = currentPage.startsWith("#/notes") ? getHashSearchParams(currentPage) : null;
  const currentNotesProject = currentNotesParams
    ? data.projects.find((project) => project.id === currentNotesParams.get("project"))
    : null;
  const currentNotesRecord = currentNotesProject?.records.find((record) => record.id === currentNotesParams?.get("record"));
  const currentNotesRecords = currentNotesProject?.records || [];
  const visibleNotesRecords = currentNotesRecords.filter(
    (record) =>
      String(record.researchNotes || "").trim() ||
      String(recordNotesDrafts[record.id] || "").trim() ||
      record.id === currentNotesRecord?.id
  );

  useEffect(() => {
    if (!currentPage.startsWith("#/notes")) return;
    setRecordNotesDrafts(
      Object.fromEntries(currentNotesRecords.map((record) => [record.id, record.researchNotes || ""]))
    );
  }, [currentPage, currentNotesProject?.id, currentNotesRecords]);

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

  const favoriteRecords = useMemo(() => allRecords.filter((record) => record.bookmarked), [allRecords]);

  const duplicateGroups = useMemo(() => {
    if (currentPage !== "#/analysis/duplicates") return [];

    const confidenceRank = { Exact: 3, Likely: 2, Possible: 1 };
    const parent = new Map(allRecords.map((record) => [record.id, record.id]));
    const groupConfidence = new Map();
    const strongestConfidence = (left, right) =>
      (confidenceRank[left] || 0) >= (confidenceRank[right] || 0) ? left : right;

    function find(recordId) {
      const parentId = parent.get(recordId);
      if (parentId === recordId) return recordId;
      const root = find(parentId);
      parent.set(recordId, root);
      return root;
    }

    function join(leftId, rightId, confidence) {
      const leftRoot = find(leftId);
      const rightRoot = find(rightId);
      const nextConfidence = strongestConfidence(confidence, groupConfidence.get(leftRoot));

      if (leftRoot !== rightRoot) {
        parent.set(rightRoot, leftRoot);
        const rightConfidence = groupConfidence.get(rightRoot);
        groupConfidence.set(leftRoot, strongestConfidence(nextConfidence, rightConfidence));
        return;
      }

      groupConfidence.set(leftRoot, nextConfidence);
    }

    const buckets = new Map();
    const comparedPairs = new Set();
    const addToBucket = (key, record) => {
      if (!key) return;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(record);
    };

    allRecords.forEach((record) => {
      const profile = getRecordMatchProfile(record);
      const nameKey = profile.surname || profile.name;
      if (!nameKey) return;

      if (profile.year && profile.location) addToBucket(`year-name-location|${profile.year}|${nameKey}|${profile.location}`, record);
      if (profile.year) addToBucket(`year-name|${profile.year}|${nameKey}`, record);
      if (profile.location) addToBucket(`name-location|${nameKey}|${profile.location}`, record);
      if (profile.birth || profile.age) addToBucket(`name-birth|${nameKey}|${profile.birth || profile.age}`, record);
    });

    buckets.forEach((bucket) => {
      if (bucket.length > DUPLICATE_BUCKET_LIMIT) return;

      for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex += 1) {
          const pairKey = [bucket[leftIndex].id, bucket[rightIndex].id].sort().join("|");
          if (comparedPairs.has(pairKey)) continue;
          comparedPairs.add(pairKey);

          const confidence = getDuplicateConfidence(bucket[leftIndex], bucket[rightIndex]);
          if (confidence) join(bucket[leftIndex].id, bucket[rightIndex].id, confidence);
        }
      }
    });

    const groups = new Map();
    allRecords.forEach((record) => {
      const root = find(record.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(record);
    });

    return Array.from(groups.entries())
      .map(([root, records]) => ({
        id: root,
        confidence: groupConfidence.get(root) || "Possible",
        records: records.sort((left, right) => {
          const yearComparison = compareRecordValues(left.year, right.year);
          if (yearComparison !== 0) return yearComparison;
          return compareRecordValues(left.name, right.name);
        }),
      }))
      .filter((group) => group.records.length > 1)
      .sort((left, right) => {
        const confidenceComparison = confidenceRank[right.confidence] - confidenceRank[left.confidence];
        if (confidenceComparison !== 0) return confidenceComparison;
        return compareRecordValues(left.records[0]?.name, right.records[0]?.name);
      });
  }, [allRecords, currentPage]);

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

  const neighborResults = useMemo(() => {
    const firstName = neighborsSearch.firstName.trim().toLowerCase();
    const lastName = neighborsSearch.lastName.trim().toLowerCase();
    const birth = neighborsSearch.birth.trim().toLowerCase();
    const location = neighborsSearch.location.trim().toLowerCase();

    if (!firstName && !lastName && !birth && !location) return [];

    return data.projects.flatMap((project) => {
      return project.records
        .map((record, index) => ({ record, index }))
        .filter(({ record }) => {
          const name = String(record.name || "").toLowerCase();
          const recordLocation = String(record.location || "").toLowerCase();
          const notes = String(record.notes || "").toLowerCase();

          if (firstName && !name.includes(firstName)) return false;
          if (lastName && !name.includes(lastName)) return false;
          if (birth && !notes.includes(birth) && !String(record.year || "").includes(birth)) return false;
          if (location && !recordLocation.includes(location) && !notes.includes(location)) return false;

          return true;
        })
        .map(({ record, index }) => {
          const recordLocation = String(record.location || "").trim().toLowerCase();
          const nearbyRecords = project.records
            .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
            .filter(({ candidate }) => {
              const sameYear = String(candidate.year || "") === String(record.year || "");
              const sameLocation =
                !recordLocation || String(candidate.location || "").trim().toLowerCase() === recordLocation;
              return sameYear && sameLocation;
            });
          const households = [];

          nearbyRecords.forEach(({ candidate, candidateIndex }) => {
            const dwellingNumber = getRecordDwellingNumber(candidate);
            const familyNumber = getRecordFamilyNumber(candidate);
            const householdKey = getRecordDwellingOrFamilyKey(candidate);
            const existingHousehold = households.find((household) => household.key === householdKey);

            if (existingHousehold) {
              existingHousehold.records.push(candidate);
              if (isHeadOfHousehold(candidate)) existingHousehold.head = candidate;
              return;
            }

            households.push({
              key: householdKey,
              dwellingNumber,
              familyNumber,
              head: candidate,
              firstIndex: candidateIndex,
              records: [candidate],
            });
          });

          const matchHouseholdKey = getRecordDwellingOrFamilyKey(record);
          const matchHouseholdIndex = households.findIndex((household) =>
            household.key === matchHouseholdKey || household.records.some((candidate) => candidate.id === record.id)
          );
          const neighbors =
            matchHouseholdIndex >= 0
              ? households.slice(Math.max(0, matchHouseholdIndex - 5), matchHouseholdIndex + 6)
              : project.records.slice(Math.max(0, index - 5), index + 6).map((candidate, candidateIndex) => ({
                  key: getRecordDwellingOrFamilyKey(candidate),
                  dwellingNumber: getRecordDwellingNumber(candidate),
                  familyNumber: getRecordFamilyNumber(candidate),
                  head: candidate,
                  firstIndex: Math.max(0, index - 5) + candidateIndex,
                  records: [candidate],
                }));

          return {
            projectId: project.id,
            projectName: project.name,
            match: record,
            matchHouseholdKey,
            neighbors,
          };
        });
    });
  }, [data.projects, neighborsSearch]);

  const householdResults = useMemo(() => {
    const firstName = householdSearch.firstName.trim().toLowerCase();
    const lastName = householdSearch.lastName.trim().toLowerCase();
    const birth = householdSearch.birth.trim().toLowerCase();
    const location = householdSearch.location.trim().toLowerCase();

    if (!firstName && !lastName && !birth && !location) return [];

    return data.projects.flatMap((project) => {
      return project.records
        .map((record) => ({ ...record, projectId: project.id, projectName: project.name }))
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
        .map((match) => {
          const householdKey = getRecordHouseholdKey(match);
          const members = project.records
            .map((record) => ({ ...record, projectId: project.id, projectName: project.name }))
            .filter((record) => getRecordHouseholdKey(record) === householdKey);

          return {
            projectId: project.id,
            projectName: project.name,
            match,
            dwellingNumber: getRecordDwellingNumber(match),
            members: members.length > 0 ? members : [match],
          };
        });
    });
  }, [data.projects, householdSearch]);

  const filteredRecords = useMemo(() => {
    return allRecords.filter((record) => {
      if (!recordMatchesTextFilter(record, query)) return false;
      if (yearFilter !== "all" && record.year !== yearFilter) return false;
      if (showBookmarkedOnly && !record.bookmarked) return false;
      return true;
    });
  }, [allRecords, query, yearFilter, showBookmarkedOnly]);

  const visibleSearchRecords = searchResultsCleared ? [] : filteredRecords;
  const limitedSearchRecords = visibleSearchRecords.slice(0, searchResultLimit);
  const hiddenSearchRecordCount = Math.max(0, visibleSearchRecords.length - limitedSearchRecords.length);
  const selectedRecordsByYear = recordsByYearSelection || years[0] || "";
  const recordsByYear = useMemo(() => {
    const sortAccessors = {
      page: getRecordPageNumber,
      location: (record) => record.location,
      surname: getRecordSurname,
      dwelling: getRecordDwellingNumber,
      line: getRecordLineNumber,
      family: getRecordFamilyNumber,
    };
    const getSortValue = sortAccessors[recordsByYearSort.field] || sortAccessors.page;

    return allRecords
      .filter((record) => String(record.year || "") === String(selectedRecordsByYear || ""))
      .filter((record) => recordMatchesTextFilter(record, recordsByYearFilter))
      .sort((left, right) => {
        const primaryComparison = compareRecordValues(
          getSortValue(left),
          getSortValue(right),
          recordsByYearSort.direction
        );
        if (primaryComparison !== 0) return primaryComparison;

        const lineComparison = compareRecordValues(getRecordLineNumber(left), getRecordLineNumber(right));
        if (lineComparison !== 0) return lineComparison;

        return compareRecordValues(left.name, right.name);
      });
  }, [allRecords, recordsByYearFilter, recordsByYearSort, selectedRecordsByYear]);

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
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
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
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
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

  async function mergeActiveProject() {
    if (!activeProject || !validMergeTargetProjectId) return;

    const targetProject = data.projects.find((project) => project.id === validMergeTargetProjectId);
    if (!targetProject) return;

    const confirmed = window.confirm(
      `Merge "${activeProject.name}" into "${targetProject.name}"? ${activeProject.records.length} ${activeProject.records.length === 1 ? "record" : "records"} will move, and "${activeProject.name}" will be removed. This cannot be undone.`
    );
    if (!confirmed) return;

    if (apiConnected) {
      try {
        await api.mergeProject(activeProject.id, targetProject.id);
        const projects = await api.fetchProjects();
        setData(toData(projects, targetProject.id));
        setMergeTargetProjectId("");
        return;
      } catch {
        setApiConnected(false);
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
      }
    }

    setData((prev) => {
      const sourceProject = prev.projects.find((project) => project.id === activeProject.id);
      if (!sourceProject) return prev;

      const projects = prev.projects
        .map((project) =>
          project.id === targetProject.id
            ? { ...project, records: [...project.records, ...sourceProject.records] }
            : project
        )
        .filter((project) => project.id !== sourceProject.id);

      return {
        activeProjectId: targetProject.id,
        projects,
      };
    });
    setMergeTargetProjectId("");
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
        record = await api.createRecord(activeProject.id, recordToApiPayload(recordDraft));
      } catch {
        setApiConnected(false);
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
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
        await api.updateRecord(recordId, recordChangesToApiPayload(changes));
      } catch {
        setApiConnected(false);
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
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

  async function updateRecordAction(projectId, recordId, changes, message = "Updating...") {
    setRecordActionMessage(message);
    await updateRecord(projectId, recordId, changes);
    window.setTimeout(() => {
      setRecordActionMessage((current) => (current === message ? "" : current));
    }, 700);
  }

  async function deleteRecord(projectId, recordId) {
    const project = data.projects.find((candidate) => candidate.id === projectId);
    const record = project?.records.find((candidate) => candidate.id === recordId);
    const confirmed = window.confirm(
      `Delete "${record?.name || "this record"}"? This cannot be undone.`
    );
    if (!confirmed) return;

    if (apiConnected) {
      try {
        await api.deleteRecord(recordId);
      } catch {
        setApiConnected(false);
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
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

  function toggleSelectedProjectRecord(recordId, checked) {
    setSelectedProjectRecordIds((prev) => {
      if (checked) return prev.includes(recordId) ? prev : [...prev, recordId];
      return prev.filter((candidate) => candidate !== recordId);
    });
  }

  async function deleteSelectedProjectRecords() {
    const selectedRecordIdSet = new Set(selectedProjectRecordIds);
    const selectedRecords = data.projects.flatMap((project) =>
      project.records
        .filter((record) => selectedRecordIdSet.has(record.id))
        .map((record) => ({ projectId: project.id, recordId: record.id }))
    );

    if (selectedRecords.length === 0) return;

    const confirmed = window.confirm(
      `Delete ${selectedRecords.length} selected ${selectedRecords.length === 1 ? "record" : "records"}? This cannot be undone.`
    );
    if (!confirmed) return;

    if (apiConnected) {
      try {
        await Promise.all(selectedRecords.map((record) => api.deleteRecord(record.recordId)));
      } catch {
        setApiConnected(false);
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
      }
    }

    setData((prev) => ({
      ...prev,
      projects: prev.projects.map((project) => ({
        ...project,
        records: project.records.filter((record) => !selectedRecordIdSet.has(record.id)),
      })),
    }));
    setSelectedProjectRecordIds([]);
  }

  function startEditingSearchRecord(record) {
    setEditingSearchRecordId(record.id);
    setEditingSearchRecordDraft({
      year: record.year || "",
      name: record.name || "",
      birthYear: getRecordBirthYear(record),
      location: record.location || "",
      household: record.household || "",
      notes: record.notes || "",
      detailFields: Object.fromEntries(
        getRecordDetailFieldEntries(record).map((entry) => [
          normalizeFieldLabel(entry.label),
          { label: entry.label, value: entry.value },
        ])
      ),
    });
  }

  function cancelEditingSearchRecord() {
    setEditingSearchRecordId("");
    setEditingSearchRecordDraft({
      year: "",
      name: "",
      birthYear: "",
      location: "",
      household: "",
      notes: "",
      detailFields: {},
    });
  }

  async function saveEditingSearchRecord(projectId, recordId) {
    const { birthYear, detailFields, ...recordDraft } = editingSearchRecordDraft;
    const recordWithBirthYear = {
      ...recordDraft,
      notes: updateNoteValue(recordDraft.notes, ["Birth Year", "Estimated Birth Year", "Year of Birth", "Birth"], "Birth Year", birthYear),
    };
    const recordWithDetails = updateRecordDetailFields(recordWithBirthYear, detailFields);

    await updateRecord(projectId, recordId, {
      ...recordDraft,
      household: recordWithDetails.household,
      notes: recordWithDetails.notes,
    });
    cancelEditingSearchRecord();
  }

  async function saveProjectNotes() {
    if (!currentNotesProject) return;

    const changedRecords = currentNotesRecords.filter(
      (record) => (recordNotesDrafts[record.id] || "") !== (record.researchNotes || "")
    );
    if (changedRecords.length === 0) return;

    setRecordActionMessage("Saving notes...");

    for (const record of changedRecords) {
      await updateRecord(currentNotesProject.id, record.id, {
        researchNotes: recordNotesDrafts[record.id] || "",
      });
    }

    window.setTimeout(() => {
      setRecordActionMessage((current) => (current === "Saving notes..." ? "" : current));
    }, 700);
  }

  async function importTemplateRows(template, templateRows) {
    if (!activeProject) return;

    const records = templateRows.map((row) => templateRowToRecord(template, row));
    const savedRecords = [];

    if (apiConnected) {
      try {
        for (const record of records) {
          savedRecords.push(await api.createRecord(activeProject.id, recordToApiPayload(record)));
        }
      } catch {
        setApiConnected(false);
        setStatusMessage("Could not reach your private data service. Changes are saving locally for now.");
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
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadFile(`census-notebook-backup-${timestamp}.json`, JSON.stringify(data, null, 2));
  }

  function importBackupFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const importedData = JSON.parse(String(reader.result || ""));
        if (!Array.isArray(importedData.projects)) {
          window.alert("This backup file does not look like a Census Notebook backup.");
          return;
        }

        const confirmed = window.confirm(
          "Import this backup? It will replace the projects currently stored on this device."
        );
        if (!confirmed) return;

        const normalizedData = toData(importedData.projects, importedData.activeProjectId);
        setData(normalizedData);
        setDataStorageReady(true);
        writeLocalDatabaseData(normalizedData).catch(() => {
          window.alert("The backup was opened, but Census Notebook could not save it locally.");
        });
      } catch {
        window.alert("Census Notebook could not read this backup file.");
      } finally {
        event.target.value = "";
      }
    };

    reader.readAsText(file);
  }

  const pageStyle = {
    minHeight: "100vh",
    minWidth: "fit-content",
    backgroundColor: "#f6f0e3",
    backgroundImage: `
      linear-gradient(rgba(55, 65, 81, 0.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(55, 65, 81, 0.04) 1px, transparent 1px),
      radial-gradient(circle at 18% 12%, rgba(146, 64, 14, 0.09), transparent 28%),
      radial-gradient(circle at 82% 8%, rgba(30, 64, 175, 0.06), transparent 24%),
      linear-gradient(135deg, #fbf7ed 0%, #f4ead8 48%, #efe4cf 100%)
    `,
    backgroundSize: "42px 42px, 42px 42px, 100% 100%, 100% 100%, 100% 100%",
    backgroundAttachment: "fixed",
    color: "#111827",
    fontFamily: "Arial, Helvetica, sans-serif",
    padding: "24px",
    boxSizing: "border-box",
  };

  const shellStyle = {
    width: "100%",
    maxWidth: "1800px",
    margin: "0 auto",
  };

  const headerStyle = {
    background: "rgba(255, 252, 246, 0.94)",
    padding: "32px",
    borderRadius: "18px",
    border: "1px solid rgba(120, 113, 108, 0.18)",
    boxShadow: "0 18px 45px rgba(68, 53, 35, 0.12)",
    marginBottom: "24px",
    textAlign: "center",
  };

  const mainStyle = {
    display: "grid",
    gridTemplateColumns: "300px minmax(0, 1fr)",
    gap: "24px",
    alignItems: "start",
  };

  const sidebarStyle = {
    position: "sticky",
    top: "20px",
    alignSelf: "start",
  };

  const cardStyle = {
    background: "rgba(255, 252, 246, 0.95)",
    padding: "20px",
    borderRadius: "16px",
    border: "1px solid rgba(120, 113, 108, 0.16)",
    boxShadow: "0 12px 30px rgba(68, 53, 35, 0.10)",
    marginBottom: "16px",
  };

  const navLinkStyle = {
    display: "block",
    padding: "14px",
    background: "#efe7d8",
    border: "1px solid rgba(120, 113, 108, 0.18)",
    borderRadius: "12px",
    textDecoration: "none",
    color: "#111827",
    fontWeight: "700",
    textAlign: "center",
  };

  const buttonStyle = {
    padding: "10px 14px",
    borderRadius: "10px",
    border: "1px solid rgb(47 68 115)",
    background: "rgb(47 68 115)",
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
    whiteSpace: "nowrap",
  };

  const actionButtonStyle = {
    ...lightButtonStyle,
    width: "30px",
    height: "30px",
    padding: 0,
    borderRadius: "8px",
    fontSize: "15px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const highlightActionButtonStyle = (isHighlighted) => ({
    ...actionButtonStyle,
    background: isHighlighted ? "#facc15" : "#fef3c7",
    borderColor: "#f59e0b",
    color: "#78350f",
    fontWeight: "800",
  });

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

  const stickyTableHeaderCellStyle = {
    padding: "12px",
    textAlign: "left",
    borderBottom: "1px solid #e5e7eb",
    position: "sticky",
    top: 0,
    zIndex: 3,
    background: "#f3f4f6",
    boxShadow: "0 1px 0 #e5e7eb",
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

  const helpTopics = [
    {
      href: "#/help/getting-started",
      label: "Getting Started",
      description: "Create a project, add census data, then use analysis tools to find patterns.",
      keywords: ["start", "workflow", "analysis", "patterns"],
    },
    {
      href: "#/help/how-it-works",
      label: "How Census Notebook Works",
      description: "Learn how local storage, projects, searching, and privacy fit together.",
      keywords: ["favorites", "favorite", "highlight", "highlights", "notes", "record actions", "search", "privacy", "local storage"],
    },
    {
      href: "#/help/projects",
      label: "Working with Projects",
      description: "Organize records by surname, place, time period, or family branch.",
      keywords: ["project", "projects", "merge", "merging", "delete project", "temporary project", "import project"],
    },
    {
      href: "#/help/census-image-text",
      label: "Converting a Census Image Into Text",
      description: "Download an image, transcribe it with OCR or AI, clean it up, and import it.",
      keywords: ["ancestry", "excel", "paste special", "view text", "ocr", "ai prompt", "live text", "transcription"],
    },
    {
      href: "#/help/census-years",
      label: "Census Versions Through the Years",
      description: "Understand how census questions and available fields changed over time.",
      keywords: ["years", "versions", "questions", "fields", "1790", "1890", "1950"],
    },
    {
      href: "#/help/templates",
      label: "Using Templates",
      description: "Paste spreadsheet rows, import CSV files, attach source documents, and save template data.",
      keywords: ["template", "templates", "csv", "spreadsheet", "paste", "rows", "columns", "download blank template"],
    },
    {
      href: "#/help/manual-records",
      label: "Adding Records Manually",
      description: "Type a single record from the Home page or enter rows directly in a census template.",
      keywords: ["manual", "add record", "single record", "type records"],
    },
    {
      href: "#/help/modifying-records",
      label: "Modifying Records",
      description: "Fine-tune imported records and update census fields after they are added.",
      keywords: ["edit", "modify", "update", "correct", "fix", "delete record"],
    },
    {
      href: "#/help/import-scope",
      label: "How Much Census Data Should You Import?",
      description: "Decide whether to import full pages, direct family households, or both.",
      keywords: ["full page", "neighbors", "household", "direct family", "scope"],
    },
    {
      href: "#/help/cleaning-data",
      label: "Tips for Cleaning Up Data Before Import",
      description: "Prepare OCR or spreadsheet data so imports, searches, and analysis work better.",
      keywords: ["clean", "cleanup", "ocr", "spreadsheet", "columns", "names", "locations"],
    },
    {
      href: "#/help/sources-attachments",
      label: "Sources & Attachments",
      description: "Organize census images and PDFs in your own source folder.",
      keywords: ["sources", "attachments", "images", "pdf", "folder", "files"],
    },
    {
      href: "#/help/known-limitations",
      label: "Known Limitations",
      description: "Understand local storage, backups, attachments, and browser limits.",
      keywords: ["backup", "browser", "storage", "limitations", "lost data", "incognito", "private window"],
    },
  ];
  const filteredHelpTopics = helpTopics.filter((topic) => {
    const searchTerms = helpSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (searchTerms.length === 0) return true;
    const indexedText = `${topic.label} ${topic.description} ${(topic.keywords || []).join(" ")}`.toLowerCase();
    return searchTerms.every((term) => indexedText.includes(term));
  });

  const renderHelpTopicControls = () => (
    <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
      <a
        href="#/"
        style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}
      >
        Back to Home
      </a>
      <select
        value={currentPage}
        onChange={(event) => {
          window.location.hash = event.target.value;
        }}
        style={{ ...inputStyle, minWidth: "260px" }}
        aria-label="Choose help topic"
      >
        {helpTopics.map((topic) => (
          <option key={topic.href} value={topic.href}>
            {topic.label}
          </option>
        ))}
      </select>
    </div>
  );

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
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
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
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/collect-census-images") {
    return (
      <SourceImageCollectionPage
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
          onViewRecordsByYear={setRecordsByYearSelection}
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
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
            </a>
          </header>

          <section style={{ ...cardStyle, maxWidth: "760px", margin: "0 auto", textAlign: "left" }}>
            <h2 style={sectionTitleStyle}>Template data coming later</h2>
            <p style={{ color: "#4b5563", lineHeight: 1.6 }}>
              This year is available in the template picker. The spreadsheet-style fields will appear
              here once the template data is added.
            </p>
          </section>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/records-by-year") {
    const sortButtonStyle = (field) => ({
      background: "none",
      border: "none",
      padding: 0,
      color: "#111827",
      cursor: "pointer",
      fontWeight: "700",
      font: "inherit",
      textAlign: "left",
      textDecoration: recordsByYearSort.field === field ? "underline" : "none",
    });

    const changeRecordsByYearSort = (field) => {
      setRecordsByYearLimit(PROJECT_RECORD_RENDER_LIMIT);
      setRecordsByYearSort((prev) => ({
        field,
        direction: prev.field === field && prev.direction === "asc" ? "desc" : "asc",
      }));
    };

    const sortHeaderLabel = (field, label) => (
      <button onClick={() => changeRecordsByYearSort(field)} style={sortButtonStyle(field)}>
        {label}
        {recordsByYearSort.field === field ? ` ${recordsByYearSort.direction === "asc" ? "↑" : "↓"}` : ""}
      </button>
    );
    const selectedYearTemplate = allTemplates.find((template) => String(template.year || template.label || "") === String(selectedRecordsByYear || ""));
    const yearTemplateFieldLabels = selectedYearTemplate
      ? selectedYearTemplate.columns
          .filter((column) => !["location", "surname", "givenName"].includes(column.key))
          .map((column) => column.label)
      : [];
    const recordsByYearFallbackFieldLabels = Array.from(
      new Map(
        recordsByYear.flatMap((record) =>
          getRecordDetailFieldEntries(record).map((entry) => [entry.label.toLowerCase(), entry.label])
        )
      ).values()
    );
    const recordsByYearFieldLabels =
      yearTemplateFieldLabels.length > 0 ? yearTemplateFieldLabels : recordsByYearFallbackFieldLabels;
    const recordsByYearTableMinWidth = `${Math.max(1160, 560 + recordsByYearFieldLabels.length * 140)}px`;

    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Records by year
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>View Census Records by Year</h1>
            <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
              <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
                Back to Home
              </a>
              <a href="#/project-data" style={{ ...lightButtonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
                View Records by Project
              </a>
            </div>
          </header>

          <main style={{ maxWidth: "1180px", margin: "0 auto", textAlign: "left" }}>
            <section style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <h2 style={sectionTitleStyle}>Census Year</h2>
                  <p style={{ margin: 0, color: "#4b5563" }}>
                    Showing {recordsByYear.length} {recordsByYear.length === 1 ? "record" : "records"} for {selectedRecordsByYear || "no year selected"}.
                  </p>
                </div>

                <select
                  value={selectedRecordsByYear}
                  onChange={(event) => {
                    setRecordsByYearSelection(event.target.value);
                    setRecordsByYearLimit(PROJECT_RECORD_RENDER_LIMIT);
                  }}
                  style={{ ...inputStyle, minWidth: "220px" }}
                >
                  {years.length === 0 && <option value="">No years available</option>}
                  {years.map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </div>
            </section>

            <section style={cardStyle}>
              <div style={{ marginBottom: "14px" }}>
                <h2 style={sectionTitleStyle}>Records</h2>
                <input
                  value={recordsByYearFilter}
                  onChange={(event) => {
                    setRecordsByYearFilter(event.target.value);
                    setRecordsByYearLimit(PROJECT_RECORD_RENDER_LIMIT);
                  }}
                  placeholder="Filter name, location, note..."
                  style={{ ...inputStyle, marginTop: "8px", minWidth: "260px", maxWidth: "360px", width: "100%" }}
                />
                <p style={{ margin: "6px 0 0", color: "#4b5563" }}>
                  Click the header to sort by Surname, Location, or Page.
                </p>
              </div>

              <div style={{ overflow: "auto", maxHeight: "70vh" }}>
                <table style={{ width: "100%", minWidth: recordsByYearTableMinWidth, borderCollapse: "separate", borderSpacing: 0, fontSize: "14px" }}>
                  <thead>
                    <tr style={{ background: "#f3f4f6" }}>
                      <th style={stickyTableHeaderCellStyle}>Year</th>
                      <th style={stickyTableHeaderCellStyle}>
                        {sortHeaderLabel("surname", "Name")}
                      </th>
                      <th style={stickyTableHeaderCellStyle}>
                        {sortHeaderLabel("location", "Location")}
                      </th>
                      {recordsByYearFieldLabels.map((label) => (
                        <th key={label} style={stickyTableHeaderCellStyle}>
                          {label.toLowerCase() === "page" ? sortHeaderLabel("page", "Page") : label}
                        </th>
                      ))}
                      <th style={stickyTableHeaderCellStyle}>Project</th>
                      <th style={{ ...stickyTableHeaderCellStyle, width: "150px" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordsByYear.slice(0, recordsByYearLimit).map((record) => {
                      const isEditing = editingSearchRecordId === record.id;

                      return (
                        <tr key={record.id} style={{ background: record.highlighted ? "#fef9c3" : "white" }}>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.year}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, year: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "90px" }}
                              />
                            ) : (
                              record.year
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.name}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, name: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "180px" }}
                              />
                            ) : (
                              <a
                                href={`#/project-data?project=${record.projectId}&record=${record.id}`}
                                style={{ color: "#1d4ed8", textDecoration: "none" }}
                              >
                                {record.name || "Unnamed record"}
                              </a>
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.location}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, location: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "160px" }}
                              />
                            ) : (
                              record.location
                            )}
                          </td>
                          {recordsByYearFieldLabels.map((label) => (
                            <td key={label} style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                              {isEditing ? (
                                <input
                                  value={
                                    editingSearchRecordDraft.detailFields[normalizeFieldLabel(label)]?.value ??
                                    getRecordDetailFieldValue(record, label)
                                  }
                                  onChange={(event) =>
                                    setEditingSearchRecordDraft((prev) => ({
                                      ...prev,
                                      detailFields: {
                                        ...prev.detailFields,
                                        [normalizeFieldLabel(label)]: {
                                          label,
                                          value: event.target.value,
                                        },
                                      },
                                    }))
                                  }
                                  style={{ ...inputStyle, minWidth: "130px" }}
                                />
                              ) : (
                                getRecordDetailFieldValue(record, label) || "—"
                              )}
                            </td>
                          ))}
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                            {record.projectName}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", width: "180px" }}>
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                              {isEditing ? (
                                <>
                                  <button
                                    onClick={() => saveEditingSearchRecord(record.projectId, record.id)}
                                    style={buttonStyle}
                                  >
                                    Save
                                  </button>
                                  <button onClick={cancelEditingSearchRecord} style={lightButtonStyle}>
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => startEditingSearchRecord(record)}
                                    aria-label="Edit record"
                                    title="Edit"
                                    style={actionButtonStyle}
                                  >
                                    ✎
                                  </button>
                                  <button
                                    onClick={() => updateRecordAction(record.projectId, record.id, { bookmarked: !record.bookmarked }, "Updating favorite...")}
                                    aria-label={record.bookmarked ? "Remove favorite" : "Mark as favorite"}
                                    title={record.bookmarked ? "Remove favorite" : "Favorite"}
                                    style={actionButtonStyle}
                                  >
                                    {record.bookmarked ? "★" : "☆"}
                                  </button>
                                  <button
                                    onClick={() => updateRecordAction(record.projectId, record.id, { highlighted: !record.highlighted }, "Updating highlight...")}
                                    aria-label={record.highlighted ? "Remove highlight" : "Highlight record"}
                                    title={record.highlighted ? "Remove highlight" : "Highlight"}
                                    style={highlightActionButtonStyle(record.highlighted)}
                                  >
                                    H
                                  </button>
                                  <button
                                    onClick={() => deleteRecord(record.projectId, record.id)}
                                    aria-label="Delete record"
                                    title="Delete"
                                    style={{ ...actionButtonStyle, color: "#dc2626" }}
                                  >
                                    X
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {recordsByYear.length > recordsByYearLimit && (
                      <tr>
                        <td colSpan={5 + recordsByYearFieldLabels.length} style={{ padding: "18px", textAlign: "center", color: "#4b5563", fontWeight: "700" }}>
                          <div style={{ display: "flex", justifyContent: "center", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                            <span>
                              Showing first {recordsByYearLimit} of {recordsByYear.length} records for this year.
                            </span>
                            <button
                              type="button"
                              onClick={() => setRecordsByYearLimit((prev) => prev + PROJECT_RECORD_RENDER_LIMIT)}
                              style={lightButtonStyle}
                            >
                              Show More
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}

                    {recordsByYear.length === 0 && (
                      <tr>
                        <td colSpan={5 + recordsByYearFieldLabels.length} style={{ padding: "28px", textAlign: "center", color: "#6b7280" }}>
                          No records found for this year.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </main>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/favorites") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Favorites
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Favorite Records</h1>
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
            </a>
          </header>

          <main style={{ maxWidth: "1180px", margin: "0 auto", textAlign: "left" }}>
            <section style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "baseline", flexWrap: "wrap" }}>
                <h2 style={sectionTitleStyle}>Starred Records</h2>
                <span style={{ color: "#6b7280", fontWeight: "700" }}>
                  {favoriteRecords.length} {favoriteRecords.length === 1 ? "favorite" : "favorites"}
                </span>
              </div>

              <div style={{ overflowX: "auto", marginTop: "14px" }}>
                <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse", fontSize: "14px" }}>
                  <thead>
                    <tr style={{ background: "#f3f4f6" }}>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Year</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Name</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Location</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Birth</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Project</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb", width: "150px" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {favoriteRecords.map((record) => {
                      const isEditing = editingSearchRecordId === record.id;

                      return (
                        <tr key={record.id} style={{ background: record.highlighted ? "#fef9c3" : "white" }}>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.year}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, year: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "90px" }}
                              />
                            ) : (
                              record.year
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.name}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, name: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "180px" }}
                              />
                            ) : (
                              <a
                                href={`#/project-data?project=${record.projectId}&record=${record.id}`}
                                style={{ color: "#1d4ed8", textDecoration: "none" }}
                              >
                                {record.name || "Unnamed record"}
                              </a>
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.location}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, location: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "160px" }}
                              />
                            ) : (
                              record.location
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.birthYear}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, birthYear: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "110px" }}
                              />
                            ) : (
                              getRecordBirthYear(record) || "—"
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>{record.projectName}</td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", width: "150px" }}>
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                              {isEditing ? (
                                <>
                                  <button
                                    onClick={() => saveEditingSearchRecord(record.projectId, record.id)}
                                    style={buttonStyle}
                                  >
                                    Save
                                  </button>
                                  <button onClick={cancelEditingSearchRecord} style={lightButtonStyle}>
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => startEditingSearchRecord(record)}
                                    aria-label="Edit record"
                                    title="Edit"
                                    style={actionButtonStyle}
                                  >
                                    ✎
                                  </button>
                                  <button
                                    onClick={() => updateRecordAction(record.projectId, record.id, { bookmarked: false }, "Updating favorite...")}
                                    aria-label="Remove favorite"
                                    title="Remove favorite"
                                    style={actionButtonStyle}
                                  >
                                    ★
                                  </button>
                                  <button
                                    onClick={() => updateRecordAction(record.projectId, record.id, { highlighted: !record.highlighted }, "Updating highlight...")}
                                    aria-label={record.highlighted ? "Remove highlight" : "Highlight record"}
                                    title={record.highlighted ? "Remove highlight" : "Highlight"}
                                    style={highlightActionButtonStyle(record.highlighted)}
                                  >
                                    H
                                  </button>
                                  <button
                                    onClick={() => deleteRecord(record.projectId, record.id)}
                                    aria-label="Delete record"
                                    title="Delete"
                                    style={{ ...actionButtonStyle, color: "#dc2626" }}
                                  >
                                    X
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {favoriteRecords.length === 0 && (
                      <tr>
                        <td colSpan="6" style={{ padding: "28px", textAlign: "center", color: "#6b7280" }}>
                          No favorite records yet. Use the star button on a record to save it here.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </main>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage.startsWith("#/project-data")) {
    const params = getHashSearchParams(currentPage);
    const selectedProjectId = params.get("project") || "all";
    const selectedRecordId = params.get("record") || "";
    const visibleProjects =
      selectedProjectId === "all"
        ? data.projects
        : data.projects.filter((project) => project.id === selectedProjectId);
    const filteredProjectRecords = new Map(
      visibleProjects.map((project) => [
        project.id,
        project.records.filter((record) => recordMatchesTextFilter(record, projectDataFilter)),
      ])
    );
    const visibleRecordCount = visibleProjects.reduce(
      (total, project) => total + (filteredProjectRecords.get(project.id)?.length || 0),
      0
    );
    const projectDataSortAccessors = {
      surname: getRecordSurname,
      location: (record) => record.location,
      page: getRecordPageNumber,
    };
    const projectDataSortButtonStyle = (field) => ({
      background: "none",
      border: "none",
      padding: 0,
      color: "#111827",
      cursor: "pointer",
      fontWeight: "700",
      font: "inherit",
      textAlign: "left",
      textDecoration: projectDataSort.field === field ? "underline" : "none",
    });
    const changeProjectDataSort = (field) => {
      setProjectRecordLimits({});
      setProjectDataSort((prev) => ({
        field,
        direction: prev.field === field && prev.direction === "asc" ? "desc" : "asc",
      }));
    };
    const projectDataSortHeaderLabel = (field, label) => (
      <button onClick={() => changeProjectDataSort(field)} style={projectDataSortButtonStyle(field)}>
        {label}
        {projectDataSort.field === field ? ` ${projectDataSort.direction === "asc" ? "↑" : "↓"}` : ""}
      </button>
    );
    const getSortedProjectRecords = (records) => {
      const getSortValue = projectDataSortAccessors[projectDataSort.field] || projectDataSortAccessors.surname;

      return [...records].sort((left, right) => {
        const primaryComparison = compareRecordValues(getSortValue(left), getSortValue(right), projectDataSort.direction);
        if (primaryComparison !== 0) return primaryComparison;

        const pageComparison = compareRecordValues(getRecordPageNumber(left), getRecordPageNumber(right));
        if (pageComparison !== 0) return pageComparison;

        return compareRecordValues(left.name, right.name);
      });
    };
    const getProjectRecordLimit = (projectId) => projectRecordLimits[projectId] || PROJECT_RECORD_RENDER_LIMIT;
    const showMoreProjectRecords = (projectId) => {
      setProjectRecordLimits((prev) => ({
        ...prev,
        [projectId]: (prev[projectId] || PROJECT_RECORD_RENDER_LIMIT) + PROJECT_RECORD_RENDER_LIMIT,
      }));
    };
    const selectedProjectRecordIdSet = new Set(selectedProjectRecordIds);
    const templateFieldOrder = new Map();
    allTemplates.forEach((template) => {
      template.columns.forEach((column) => {
        const key = column.label.toLowerCase();
        if (!templateFieldOrder.has(key)) templateFieldOrder.set(key, templateFieldOrder.size);
      });
    });
    const projectDataFieldLabels = Array.from(
      new Map(
        visibleProjects.flatMap((project) =>
          (filteredProjectRecords.get(project.id) || []).flatMap((record) =>
            getRecordDetailFieldEntries(record).map((entry) => [entry.label.toLowerCase(), entry.label])
          )
        )
      ).values()
    )
      .filter((label) => !HIDDEN_PROJECT_DATA_FIELD_LABELS.has(normalizeFieldLabel(label)))
      .sort((left, right) => {
      const leftOrder = templateFieldOrder.get(left.toLowerCase()) ?? 9999;
      const rightOrder = templateFieldOrder.get(right.toLowerCase()) ?? 9999;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.localeCompare(right);
    });
    const projectDataTableMinWidth = `${Math.max(1060, 520 + projectDataFieldLabels.length * 140)}px`;

    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Project data
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>View Census Records by Project</h1>
            <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
              <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
                Back to Home
              </a>
              <a href="#/records-by-year" style={{ ...lightButtonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
                View Records by Year
              </a>
            </div>
          </header>

          <main style={{ maxWidth: "1180px", margin: "0 auto", textAlign: "left" }}>
            <section style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <h2 style={sectionTitleStyle}>Project Records</h2>
                  <p style={{ margin: 0, color: "#4b5563" }}>
                    Showing {visibleRecordCount} {visibleRecordCount === 1 ? "record" : "records"}.
                  </p>
                </div>

                <select
                  value={selectedProjectId}
                  onChange={(event) => {
                    window.location.hash =
                      event.target.value === "all" ? "#/project-data" : `#/project-data?project=${event.target.value}`;
                  }}
                  style={{ ...inputStyle, minWidth: "240px" }}
                >
                  <option value="all">All projects</option>
                  {data.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <h2 style={sectionTitleStyle}>Records</h2>
                  <input
                    value={projectDataFilter}
                    onChange={(event) => {
                      setProjectDataFilter(event.target.value);
                      setProjectRecordLimits({});
                    }}
                    placeholder="Filter name, location, note..."
                    style={{ ...inputStyle, marginTop: "8px", minWidth: "260px", maxWidth: "360px", width: "100%" }}
                  />
                </div>
                <button
                  onClick={deleteSelectedProjectRecords}
                  disabled={selectedProjectRecordIds.length === 0}
                  style={{
                    ...buttonStyle,
                    background: selectedProjectRecordIds.length === 0 ? "#9ca3af" : "#b91c1c",
                    borderColor: selectedProjectRecordIds.length === 0 ? "#9ca3af" : "#b91c1c",
                    cursor: selectedProjectRecordIds.length === 0 ? "not-allowed" : "pointer",
                    marginTop: "2px",
                  }}
                >
                  Delete Selected{selectedProjectRecordIds.length > 0 ? ` (${selectedProjectRecordIds.length})` : ""}
                </button>
              </div>
              <p style={{ margin: "6px 0 0", color: "#4b5563" }}>
                Click the header to sort by Surname, Location, or Page.
              </p>
            </section>

            {visibleProjects.map((project) => (
              <section key={project.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "baseline", flexWrap: "wrap" }}>
                  <h2 style={sectionTitleStyle}>{project.name}</h2>
                  <span style={{ color: "#6b7280", fontWeight: "700" }}>
                    {(filteredProjectRecords.get(project.id)?.length || 0)} {(filteredProjectRecords.get(project.id)?.length || 0) === 1 ? "record" : "records"}
                  </span>
                </div>

                <div style={{ overflow: "auto", maxHeight: "70vh", marginTop: "14px" }}>
                  <table style={{ width: "100%", minWidth: projectDataTableMinWidth, borderCollapse: "separate", borderSpacing: 0, fontSize: "14px" }}>
                    <thead>
                      <tr style={{ background: "#f3f4f6" }}>
                        <th style={stickyTableHeaderCellStyle}>Year</th>
                        <th style={stickyTableHeaderCellStyle}>
                          {projectDataSortHeaderLabel("surname", "Name")}
                        </th>
                        <th style={stickyTableHeaderCellStyle}>
                          {projectDataSortHeaderLabel("location", "Location")}
                        </th>
                        {projectDataFieldLabels.map((label) => (
                          <th key={label} style={stickyTableHeaderCellStyle}>
                            {label.toLowerCase() === "page" ? projectDataSortHeaderLabel("page", "Page") : label}
                          </th>
                        ))}
                        <th style={{ ...stickyTableHeaderCellStyle, width: "150px" }}>Actions</th>
                      </tr>
                    </thead>

                    <tbody>
                      {getSortedProjectRecords(filteredProjectRecords.get(project.id) || [])
                        .slice(0, getProjectRecordLimit(project.id))
                        .map((record) => {
                        const isEditing = editingSearchRecordId === record.id;

                        return (
                          <tr
                            id={`record-${record.id}`}
                            key={record.id}
                            style={{
                              background: selectedRecordId === record.id ? "#dbeafe" : record.highlighted ? "#fef9c3" : "white",
                              outline: selectedRecordId === record.id ? "2px solid #2563eb" : "none",
                            }}
                          >
                            <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                              {isEditing ? (
                                <input
                                  value={editingSearchRecordDraft.year}
                                  onChange={(event) =>
                                    setEditingSearchRecordDraft((prev) => ({ ...prev, year: event.target.value }))
                                  }
                                  style={{ ...inputStyle, minWidth: "90px" }}
                                />
                              ) : (
                                record.year
                              )}
                            </td>
                            <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                              {isEditing ? (
                                <input
                                  value={editingSearchRecordDraft.name}
                                  onChange={(event) =>
                                    setEditingSearchRecordDraft((prev) => ({ ...prev, name: event.target.value }))
                                  }
                                  style={{ ...inputStyle, minWidth: "180px" }}
                                />
                              ) : (
                                record.name
                              )}
                            </td>
                            <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                              {isEditing ? (
                                <input
                                  value={editingSearchRecordDraft.location}
                                  onChange={(event) =>
                                    setEditingSearchRecordDraft((prev) => ({ ...prev, location: event.target.value }))
                                  }
                                  style={{ ...inputStyle, minWidth: "160px" }}
                                />
                              ) : (
                                record.location
                              )}
                            </td>
                            {projectDataFieldLabels.map((label) => (
                              <td key={label} style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                                {getRecordDetailFieldValue(record, label) || "—"}
                              </td>
                            ))}
                            <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", width: "180px" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
                                {!isEditing && (
                                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#4b5563", fontWeight: "700" }}>
                                    <input
                                      type="checkbox"
                                      checked={selectedProjectRecordIdSet.has(record.id)}
                                      onChange={(event) => toggleSelectedProjectRecord(record.id, event.target.checked)}
                                    />
                                    Select
                                  </label>
                                )}
                                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                {isEditing ? (
                                  <>
                                    <button
                                      onClick={() => saveEditingSearchRecord(project.id, record.id)}
                                      style={buttonStyle}
                                    >
                                      Save
                                    </button>
                                    <button onClick={cancelEditingSearchRecord} style={lightButtonStyle}>
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      onClick={() => startEditingSearchRecord(record)}
                                      aria-label="Edit record"
                                      title="Edit"
                                      style={actionButtonStyle}
                                    >
                                      ✎
                                    </button>
                                    <button
                                      onClick={() => updateRecordAction(project.id, record.id, { bookmarked: !record.bookmarked }, "Updating favorite...")}
                                      aria-label={record.bookmarked ? "Remove favorite" : "Mark as favorite"}
                                      title={record.bookmarked ? "Remove favorite" : "Favorite"}
                                      style={actionButtonStyle}
                                    >
                                      {record.bookmarked ? "★" : "☆"}
                                    </button>
                                    <button
                                      onClick={() => updateRecordAction(project.id, record.id, { highlighted: !record.highlighted }, "Updating highlight...")}
                                      aria-label={record.highlighted ? "Remove highlight" : "Highlight record"}
                                      title={record.highlighted ? "Remove highlight" : "Highlight"}
                                      style={highlightActionButtonStyle(record.highlighted)}
                                    >
                                      H
                                    </button>
                                    <a
                                      href={`#/notes?project=${project.id}&record=${record.id}`}
                                      style={{
                                        ...actionButtonStyle,
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        textDecoration: "none",
                                        position: "relative",
                                        background: record.researchNotes ? "#dcfce7" : actionButtonStyle.background,
                                        borderColor: record.researchNotes ? "#86efac" : actionButtonStyle.borderColor,
                                        color: record.researchNotes ? "#047857" : "#374151",
                                      }}
                                      aria-label="Open notes"
                                      title={record.researchNotes ? "Open notes" : "Add notes"}
                                    >
                                      N
                                      {record.researchNotes && (
                                        <span
                                          aria-hidden="true"
                                          style={{
                                            position: "absolute",
                                            top: "3px",
                                            right: "3px",
                                            width: "7px",
                                            height: "7px",
                                            borderRadius: "50%",
                                            background: "#16a34a",
                                          }}
                                        />
                                      )}
                                    </a>
                                    <button
                                      onClick={() => deleteRecord(project.id, record.id)}
                                      aria-label="Delete record"
                                      title="Delete"
                                      style={{ ...actionButtonStyle, color: "#dc2626" }}
                                    >
                                      X
                                    </button>
                                  </>
                                )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                        })}

                      {(filteredProjectRecords.get(project.id)?.length || 0) > getProjectRecordLimit(project.id) && (
                        <tr>
                          <td colSpan={4 + projectDataFieldLabels.length} style={{ padding: "18px", textAlign: "center", color: "#4b5563", fontWeight: "700" }}>
                            <div style={{ display: "flex", justifyContent: "center", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                              <span>
                                Showing first {getProjectRecordLimit(project.id)} of {filteredProjectRecords.get(project.id)?.length || 0} records in this project.
                              </span>
                              <button type="button" onClick={() => showMoreProjectRecords(project.id)} style={lightButtonStyle}>
                                Show More
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}

                      {(filteredProjectRecords.get(project.id)?.length || 0) === 0 && (
                        <tr>
                          <td colSpan={4 + projectDataFieldLabels.length} style={{ padding: "28px", textAlign: "center", color: "#6b7280" }}>
                            {projectDataFilter.trim() ? "No records match this filter." : "No records in this project yet."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </main>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage.startsWith("#/notes")) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header className="no-print" style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Research notes
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>
              {currentNotesProject ? `${currentNotesProject.name} Notes` : "Project Notes"}
            </h1>
            <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
              <a
                href={currentNotesProject ? `#/project-data?project=${currentNotesProject.id}&record=${currentNotesRecord?.id || ""}` : "#/project-data"}
                style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}
              >
                Back to Project Records
              </a>
              <button
                onClick={() => window.print()}
                style={{ ...lightButtonStyle, fontSize: "13px", padding: "8px 12px" }}
              >
                Print Notes
              </button>
              <select
                value={currentNotesProject?.id || ""}
                onChange={(event) => {
                  window.location.hash = event.target.value ? `#/notes?project=${event.target.value}` : "#/notes";
                }}
                style={{ ...inputStyle, minWidth: "240px", fontSize: "13px", padding: "8px 12px" }}
              >
                <option value="">Choose project</option>
                {data.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          </header>

          <main style={{ maxWidth: "980px", margin: "0 auto", textAlign: "left" }}>
            {currentNotesProject ? (
              <>
              <section className="notes-screen no-print" style={cardStyle}>
                <p style={{ marginTop: 0, color: "#4b5563", lineHeight: 1.6 }}>
                  This page shows records that have research notes. If you opened a person with no
                  notes yet, that person appears here so you can create one.
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  {visibleNotesRecords.map((record) => (
                    <div
                      key={record.id}
                      id={`notes-record-${record.id}`}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                        padding: "12px",
                        background: record.id === currentNotesRecord?.id ? "#eff6ff" : "#ffffff",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "baseline", flexWrap: "wrap" }}>
                        <a
                          href={`#/project-data?project=${currentNotesProject.id}&record=${record.id}`}
                          style={{ color: "#1d4ed8", fontWeight: "700", textDecoration: "none", fontSize: "16px" }}
                        >
                          {record.name || "Unnamed record"}
                        </a>
                        <span style={{ color: "#6b7280", fontSize: "13px" }}>
                          {[record.year, record.location].filter(Boolean).join(" · ") || "No census context"}
                        </span>
                      </div>
                      <textarea
                        value={recordNotesDrafts[record.id] || ""}
                        onChange={(event) =>
                          setRecordNotesDrafts((prev) => ({
                            ...prev,
                            [record.id]: event.target.value,
                          }))
                        }
                        placeholder="Add research thoughts, questions, source notes, conflicts, next steps..."
                        style={{
                          ...inputStyle,
                          minHeight: "130px",
                          width: "100%",
                          boxSizing: "border-box",
                          lineHeight: 1.5,
                          fontFamily: "Arial, Helvetica, sans-serif",
                          marginTop: "8px",
                        }}
                      />
                    </div>
                  ))}
                  {visibleNotesRecords.length === 0 && (
                    <p style={{ margin: 0, color: "#6b7280" }}>
                      No research notes yet. Use the N button on a project record to start one.
                    </p>
                  )}
                </div>

                <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
                  <button onClick={saveProjectNotes} style={buttonStyle}>
                    Save Notes
                  </button>
                  <a
                    href={`#/project-data?project=${currentNotesProject.id}&record=${currentNotesRecord?.id || ""}`}
                    style={{ ...lightButtonStyle, display: "inline-block", textDecoration: "none" }}
                  >
                    Back to Project Records
                  </a>
                </div>
              </section>
              <section className="notes-print" aria-label="Printable notes">
                <h1>{currentNotesProject.name} Notes</h1>
                {visibleNotesRecords
                  .filter((record) => String(recordNotesDrafts[record.id] || "").trim())
                  .map((record) => (
                    <div className="notes-print-entry" key={record.id}>
                      <div className="notes-print-name">{record.name || "Unnamed record"}</div>
                      <div className="notes-print-text">{recordNotesDrafts[record.id]}</div>
                    </div>
                  ))}
              </section>
              </>
            ) : (
              <section className="no-print" style={cardStyle}>
                <h2 style={sectionTitleStyle}>Project not found</h2>
                <p style={{ color: "#4b5563" }}>This notes page could not find the selected project.</p>
                <a href="#/project-data" style={{ ...buttonStyle, display: "inline-block", textDecoration: "none" }}>
                  Back to Project Records
                </a>
              </section>
            )}
          </main>
          <CopyrightFooter actionMessage={recordActionMessage} />
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
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
            </a>
          </header>

          <main style={{ maxWidth: "980px", margin: "0 auto", textAlign: "left" }}>
            <section style={{ ...cardStyle, padding: "28px" }}>
              <h2 style={{ ...sectionTitleStyle, fontSize: "28px" }}>Topics</h2>
              <input
                value={helpSearch}
                onChange={(event) => setHelpSearch(event.target.value)}
                placeholder="Search help topics"
                style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: "14px" }}
              />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px" }}>
                {filteredHelpTopics.map((topic) => (
                  <a key={topic.href} href={topic.href} style={{ ...navLinkStyle, textAlign: "left", background: "#f9fafb" }}>
                    <strong>{topic.label}</strong>
                    <br />
                    <span style={{ color: "#4b5563", fontWeight: "400" }}>
                      {topic.description}
                    </span>
                  </a>
                ))}
              </div>
              {filteredHelpTopics.length === 0 && (
                <p style={{ margin: "14px 0 0", color: "#6b7280" }}>No help topics match your search.</p>
              )}
            </section>
          </main>
          <CopyrightFooter actionMessage={recordActionMessage} />
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
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
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
                    <table style={{ width: "100%", minWidth: "920px", borderCollapse: "collapse", fontSize: "14px" }}>
                      <thead>
                        <tr style={{ background: "#f3f4f6" }}>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Year</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Name</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Age</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Location</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Occupation</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Birth Place</th>
                          <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb", width: "150px" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {personTimelineResults.map((record) => {
                          const isEditing = editingSearchRecordId === record.id;

                          return (
                            <tr key={`${record.projectId}-${record.id}`} style={{ background: record.highlighted ? "#fef9c3" : "white" }}>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>
                                {isEditing ? (
                                  <input
                                    value={editingSearchRecordDraft.year}
                                    onChange={(event) =>
                                      setEditingSearchRecordDraft((prev) => ({ ...prev, year: event.target.value }))
                                    }
                                    style={{ ...inputStyle, minWidth: "90px" }}
                                  />
                                ) : (
                                  record.year
                                )}
                              </td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                                {isEditing ? (
                                  <input
                                    value={editingSearchRecordDraft.name}
                                    onChange={(event) =>
                                      setEditingSearchRecordDraft((prev) => ({ ...prev, name: event.target.value }))
                                    }
                                    style={{ ...inputStyle, minWidth: "180px" }}
                                  />
                                ) : (
                                  <a
                                    href={`#/project-data?project=${record.projectId}&record=${record.id}`}
                                    style={{ color: "#1d4ed8", textDecoration: "none" }}
                                  >
                                    {record.name || "Unnamed record"}
                                  </a>
                                )}
                              </td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getNoteValue(record.notes, ["Age"]) || "—"}</td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>
                                {isEditing ? (
                                  <input
                                    value={editingSearchRecordDraft.location}
                                    onChange={(event) =>
                                      setEditingSearchRecordDraft((prev) => ({ ...prev, location: event.target.value }))
                                    }
                                    style={{ ...inputStyle, minWidth: "160px" }}
                                  />
                                ) : (
                                  record.location || "—"
                                )}
                              </td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>
                                {getNoteValue(record.notes, ["Occupation", "Usual Occupation", "Prior Occupation"]) || "—"}
                              </td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>
                                {getNoteValue(record.notes, ["Birth Place", "Birthplace", "Place of Birth", "Birth Location"]) || "—"}
                              </td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", width: "180px" }}>
                                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                  {isEditing ? (
                                    <>
                                      <button
                                        onClick={() => saveEditingSearchRecord(record.projectId, record.id)}
                                        style={buttonStyle}
                                      >
                                        Save
                                      </button>
                                      <button onClick={cancelEditingSearchRecord} style={lightButtonStyle}>
                                        Cancel
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        onClick={() => startEditingSearchRecord(record)}
                                        aria-label="Edit record"
                                        title="Edit"
                                        style={actionButtonStyle}
                                      >
                                        ✎
                                      </button>
                                      <button
                                        onClick={() => updateRecordAction(record.projectId, record.id, { bookmarked: !record.bookmarked }, "Updating favorite...")}
                                        aria-label={record.bookmarked ? "Remove favorite" : "Mark as favorite"}
                                        title={record.bookmarked ? "Remove favorite" : "Favorite"}
                                        style={actionButtonStyle}
                                      >
                                        {record.bookmarked ? "★" : "☆"}
                                      </button>
                                      <button
                                        onClick={() => updateRecordAction(record.projectId, record.id, { highlighted: !record.highlighted }, "Updating highlight...")}
                                        aria-label={record.highlighted ? "Remove highlight" : "Highlight record"}
                                        title={record.highlighted ? "Remove highlight" : "Highlight"}
                                        style={highlightActionButtonStyle(record.highlighted)}
                                      >
                                        H
                                      </button>
                                      <button
                                        onClick={() => deleteRecord(record.projectId, record.id)}
                                        aria-label="Delete record"
                                        title="Delete"
                                        style={{ ...actionButtonStyle, color: "#dc2626" }}
                                      >
                                        X
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ color: "#4b5563" }}>No matching records found.</p>
                )}
              </section>
            )}

          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/analysis/neighbors") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Analysis
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Neighbors</h1>
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Find nearby households on a census page</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Search for a head of household, then review up to 5 dwellings before and after that
              person in the same project, census year, and location.
            </p>

            <section style={helpSectionNoDividerStyle}>
              <h3>Search for a person</h3>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setNeighborsHasRun(true);
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: "10px" }}>
                  <input
                    value={neighborsSearch.lastName}
                    onChange={(event) => setNeighborsSearch((prev) => ({ ...prev, lastName: event.target.value }))}
                    placeholder="Last name"
                    style={inputStyle}
                  />
                  <input
                    value={neighborsSearch.firstName}
                    onChange={(event) => setNeighborsSearch((prev) => ({ ...prev, firstName: event.target.value }))}
                    placeholder="First name"
                    style={inputStyle}
                  />
                  <input
                    value={neighborsSearch.birth}
                    onChange={(event) => setNeighborsSearch((prev) => ({ ...prev, birth: event.target.value }))}
                    placeholder="Birth year"
                    style={inputStyle}
                  />
                  <input
                    value={neighborsSearch.location}
                    onChange={(event) => setNeighborsSearch((prev) => ({ ...prev, location: event.target.value }))}
                    placeholder="Location"
                    style={inputStyle}
                  />
                </div>
                <button type="submit" style={{ ...buttonStyle, marginTop: "12px" }}>Analyze</button>
              </form>
            </section>

            {neighborsHasRun && (
              <section style={helpSectionStyle}>
                <h3>Results</h3>
                {neighborResults.length > 0 ? (
                  neighborResults.map((result) => (
                    <div key={`${result.projectId}-${result.match.id}`} style={{ marginTop: "18px" }}>
                      <h4 style={{ margin: "0 0 8px" }}>
                        {result.match.name || "Unnamed record"} in {result.match.year || "unknown year"}
                      </h4>
                      <p style={{ margin: "0 0 10px", color: "#4b5563" }}>
                        Project: {result.projectName}
                        {result.match.location ? ` | Location: ${result.match.location}` : ""}
                      </p>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                          <thead>
                            <tr style={{ background: "#f3f4f6" }}>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Position</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Dwelling</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Family</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Head of Household</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Location</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Relationship</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Notes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.neighbors.map((household) => {
                              const candidate = household.head;
                              const matchHousehold = result.neighbors.find((item) => item.key === result.matchHouseholdKey);
                              const offset = household.firstIndex - (matchHousehold?.firstIndex || 0);
                              const position = offset === 0 ? "Match" : offset < 0 ? `${Math.abs(offset)} before` : `${offset} after`;

                              return (
                                <tr
                                  key={household.key}
                                  style={{ background: household.key === result.matchHouseholdKey ? "#dbeafe" : candidate.highlighted ? "#fef9c3" : "white" }}
                                >
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>{position}</td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{household.dwellingNumber || "—"}</td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{household.familyNumber || "—"}</td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                                    <a
                                      href={`#/project-data?project=${result.projectId}&record=${candidate.id}`}
                                      style={{ color: "#1d4ed8", textDecoration: "none" }}
                                    >
                                      {candidate.name || "Unnamed record"}
                                    </a>
                                  </td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{candidate.location}</td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getRecordRelationship(candidate) || "—"}</td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{candidate.notes}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))
                ) : (
                  <p style={{ color: "#4b5563" }}>No matching records found.</p>
                )}
              </section>
            )}

          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/analysis/household") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Analysis
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Household</h1>
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Find household members for a person</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Search for a person, then list the people entered in the same dwelling or household
              group for that census record.
            </p>

            <section style={helpSectionNoDividerStyle}>
              <h3>Search for a person</h3>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setHouseholdHasRun(true);
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: "10px" }}>
                  <input
                    value={householdSearch.lastName}
                    onChange={(event) => setHouseholdSearch((prev) => ({ ...prev, lastName: event.target.value }))}
                    placeholder="Last name"
                    style={inputStyle}
                  />
                  <input
                    value={householdSearch.firstName}
                    onChange={(event) => setHouseholdSearch((prev) => ({ ...prev, firstName: event.target.value }))}
                    placeholder="First name"
                    style={inputStyle}
                  />
                  <input
                    value={householdSearch.birth}
                    onChange={(event) => setHouseholdSearch((prev) => ({ ...prev, birth: event.target.value }))}
                    placeholder="Birth year"
                    style={inputStyle}
                  />
                  <input
                    value={householdSearch.location}
                    onChange={(event) => setHouseholdSearch((prev) => ({ ...prev, location: event.target.value }))}
                    placeholder="Location"
                    style={inputStyle}
                  />
                </div>
                <button type="submit" style={{ ...buttonStyle, marginTop: "12px" }}>Analyze</button>
              </form>
            </section>

            {householdHasRun && (
              <section style={helpSectionStyle}>
                <h3>Results</h3>
                {householdResults.length > 0 ? (
                  householdResults.map((result) => (
                    <div key={`${result.projectId}-${result.match.id}`} style={{ marginTop: "18px" }}>
                      <h4 style={{ margin: "0 0 8px" }}>
                        {result.match.name || "Unnamed record"} in {result.match.year || "unknown year"}
                      </h4>
                      <p style={{ margin: "0 0 10px", color: "#4b5563" }}>
                        Project: {result.projectName}
                        {result.match.location ? ` | Location: ${result.match.location}` : ""}
                        {result.dwellingNumber ? ` | Dwelling: ${result.dwellingNumber}` : ""}
                      </p>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", minWidth: "720px", borderCollapse: "collapse", fontSize: "14px" }}>
                          <thead>
                            <tr style={{ background: "#f3f4f6" }}>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Name</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Relationship</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Age</th>
                              <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb", width: "150px" }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.members.map((member) => {
                              const isEditing = editingSearchRecordId === member.id;
                              const rowBackground = member.highlighted ? "#fef9c3" : member.id === result.match.id ? "#dbeafe" : "white";

                              return (
                                <tr key={member.id} style={{ background: rowBackground }}>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                                    {isEditing ? (
                                      <input
                                        value={editingSearchRecordDraft.name}
                                        onChange={(event) =>
                                          setEditingSearchRecordDraft((prev) => ({ ...prev, name: event.target.value }))
                                        }
                                        style={{ ...inputStyle, minWidth: "180px" }}
                                      />
                                    ) : (
                                      <a
                                        href={`#/project-data?project=${result.projectId}&record=${member.id}`}
                                        style={{ color: "#1d4ed8", textDecoration: "none" }}
                                      >
                                        {member.name || "Unnamed record"}
                                      </a>
                                    )}
                                  </td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getRecordRelationship(member) || "—"}</td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getNoteValue(member.notes, ["Age"]) || "—"}</td>
                                  <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", width: "180px" }}>
                                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                      {isEditing ? (
                                        <>
                                          <button
                                            onClick={() => saveEditingSearchRecord(member.projectId, member.id)}
                                            style={buttonStyle}
                                          >
                                            Save
                                          </button>
                                          <button onClick={cancelEditingSearchRecord} style={lightButtonStyle}>
                                            Cancel
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button
                                            onClick={() => startEditingSearchRecord(member)}
                                            aria-label="Edit record"
                                            title="Edit"
                                            style={actionButtonStyle}
                                          >
                                            ✎
                                          </button>
                                          <button
                                            onClick={() => updateRecordAction(member.projectId, member.id, { bookmarked: !member.bookmarked }, "Updating favorite...")}
                                            aria-label={member.bookmarked ? "Remove favorite" : "Mark as favorite"}
                                            title={member.bookmarked ? "Remove favorite" : "Favorite"}
                                            style={actionButtonStyle}
                                          >
                                            {member.bookmarked ? "★" : "☆"}
                                          </button>
                                          <button
                                            onClick={() => updateRecordAction(member.projectId, member.id, { highlighted: !member.highlighted }, "Updating highlight...")}
                                            aria-label={member.highlighted ? "Remove highlight" : "Highlight record"}
                                            title={member.highlighted ? "Remove highlight" : "Highlight"}
                                            style={highlightActionButtonStyle(member.highlighted)}
                                          >
                                            H
                                          </button>
                                          <button
                                            onClick={() => deleteRecord(member.projectId, member.id)}
                                            aria-label="Delete record"
                                            title="Delete"
                                            style={{ ...actionButtonStyle, color: "#dc2626" }}
                                          >
                                            X
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))
                ) : (
                  <p style={{ color: "#4b5563" }}>No matching records found.</p>
                )}
              </section>
            )}

          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/analysis/duplicates") {
    const confidenceStyles = {
      Exact: { background: "#dcfce7", color: "#166534" },
      Likely: { background: "#fef3c7", color: "#92400e" },
      Possible: { background: "#e0f2fe", color: "#075985" },
    };
    const selectedDuplicateRecordIdSet = new Set(selectedProjectRecordIds);

    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Analysis
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Duplicates</h1>
            <a href="#/" style={{ ...buttonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}>
              Back to Home
            </a>
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Review possible duplicate records</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Census Notebook looks for records that may represent the same census entry. This page
              lets you compare possible matches and delete selected records after review.
            </p>

            <section style={helpSectionNoDividerStyle}>
              <h3>How matches are labeled</h3>
              <ul>
                <li><strong>Exact:</strong> same year, name, location, and matching page/line, dwelling, or family number.</li>
                <li><strong>Likely:</strong> same year, similar name, same location, and at least one supporting detail.</li>
                <li><strong>Possible:</strong> similar name with a shared year, location, age, or birth clue.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                <h3 style={{ margin: 0 }}>Results</h3>
                <button
                  onClick={deleteSelectedProjectRecords}
                  disabled={selectedProjectRecordIds.length === 0}
                  style={{
                    ...buttonStyle,
                    background: selectedProjectRecordIds.length === 0 ? "#9ca3af" : "#b91c1c",
                    borderColor: selectedProjectRecordIds.length === 0 ? "#9ca3af" : "#b91c1c",
                    cursor: selectedProjectRecordIds.length === 0 ? "not-allowed" : "pointer",
                  }}
                >
                  Delete Selected{selectedProjectRecordIds.length > 0 ? ` (${selectedProjectRecordIds.length})` : ""}
                </button>
              </div>
              {duplicateGroups.length > 0 ? (
                duplicateGroups.map((group) => (
                  <div key={group.id} style={{ marginTop: "18px", border: "1px solid #e5e7eb", borderRadius: "10px", overflow: "hidden" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap", padding: "12px", background: "#f9fafb" }}>
                      <h4 style={{ margin: 0 }}>
                        {group.records[0]?.name || "Unnamed records"} ({group.records.length} records)
                      </h4>
                      <span
                        style={{
                          ...(confidenceStyles[group.confidence] || confidenceStyles.Possible),
                          padding: "5px 9px",
                          borderRadius: "999px",
                          fontWeight: "700",
                          fontSize: "13px",
                        }}
                      >
                        {group.confidence}
                      </span>
                    </div>

                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse", fontSize: "14px" }}>
                        <thead>
                          <tr style={{ background: "#f3f4f6" }}>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb", width: "92px" }}>Select</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Year</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Name</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Location</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Page</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Line</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Dwelling</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Family</th>
                            <th style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Project</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.records.map((record) => (
                            <tr key={record.id} style={{ background: record.highlighted ? "#fef9c3" : "white" }}>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>
                                <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#4b5563", fontSize: "12px", fontWeight: "700" }}>
                                  <input
                                    type="checkbox"
                                    checked={selectedDuplicateRecordIdSet.has(record.id)}
                                    onChange={(event) => toggleSelectedProjectRecord(record.id, event.target.checked)}
                                  />
                                  Select
                                </label>
                              </td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{record.year}</td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                                <a
                                  href={`#/project-data?project=${record.projectId}&record=${record.id}`}
                                  style={{ color: "#1d4ed8", textDecoration: "none" }}
                                >
                                  {record.name || "Unnamed record"}
                                </a>
                              </td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{record.location}</td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getRecordPageNumber(record) || "—"}</td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getRecordLineNumber(record) || "—"}</td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getRecordDwellingNumber(record) || "—"}</td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb" }}>{getRecordFamilyNumber(record) || "—"}</td>
                              <td style={{ padding: "10px", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>{record.projectName}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              ) : (
                <p style={{ color: "#4b5563" }}>No possible duplicates found.</p>
              )}
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
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
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>A private workspace for census research</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Census Notebook is a simple, private workspace designed to help you organize and explore
              your census records without needing a complex setup or database server.
            </p>

            <section style={helpSectionStyle}>
              <h3>Ways to use it</h3>
              <p>
                Currently, Census Notebook runs in a web browser. No installation is required.
              </p>
              <p>It should work in modern versions of:</p>
              <ul>
                <li>Google Chrome</li>
                <li>Microsoft Edge</li>
                <li>Mozilla Firefox</li>
                <li>Safari</li>
              </ul>
              <p>
                For features that copy files into a local Sources folder, Chrome or Edge may provide
                the best support because they include stronger local folder permissions.
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
              <h3>Record actions</h3>
              <ul>
                <li>
                  Mark a record as a <strong>Favorite</strong> with the star button when you want to
                  return to it later. Favorites are saved with your project data and can be reviewed
                  together from the Favorites page.
                </li>
                <li>
                  Use <strong>Highlight</strong> when you want one record to stand out while you are
                  reviewing a page or comparing search results. Highlights remain visible across
                  different views so the same record is easy to spot as you move through the app.
                  Click <strong>Highlight</strong> again to turn the highlight off when you no longer
                  need that visual marker.
                </li>
                <li>
                  Use <strong>Notes</strong> when you want to keep research thoughts, questions,
                  source comments, or next steps separate from the census data itself. Notes are saved
                  with the record, can be reviewed together from the Notes page, and can be printed as
                  a simple project notes sheet.
                </li>
              </ul>
              <p>The record action buttons use simple symbols:</p>
              <ul>
                <li><strong>✎</strong> edits the record.</li>
                <li><strong>★</strong> marks the record as a Favorite. <strong>☆</strong> means it is not currently a Favorite.</li>
                <li><strong>H</strong> highlights the record. A yellow H means the highlight is turned on.</li>
                <li><strong>N</strong> opens research Notes. A green N means the record already has notes.</li>
                <li><strong>X</strong> deletes the record.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Why use Census Notebook?</h3>
              <p>Census Notebook is designed around how genealogists actually work.</p>
              <ul>
                <li>Private, local-first data storage.</li>
                <li>Flexible access in a modern web browser.</li>
                <li>Tools to help you see patterns, not just store records.</li>
              </ul>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/getting-started") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Getting Started</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>A simple workflow for census research</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Start by creating a project, bring in cleaned census data, then use the analysis tools
              to compare people, households, neighbors, and possible duplicates.
            </p>

            <section style={helpSectionStyle}>
              <h3>1. Create a Project</h3>
              <p>
                Projects keep related research together. You might create a project for a surname,
                family branch, location, or research question.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>2. Find and Add Census Data</h3>
              <p>
                Find census data online or in your own files, clean it up, then import a CSV or paste
                rows into the matching census template.
              </p>
              <p>
                Cleaning the data first helps names, locations, page numbers, and household details
                line up correctly when you search or analyze later.
              </p>
              <p>Helpful next steps:</p>
              <ul>
                <li>
                  <a href="#/help/census-image-text" style={{ color: "#1d4ed8", fontWeight: "700", textDecoration: "none" }}>
                    Converting a census image into text
                  </a>
                </li>
                <li>
                  <a href="#/help/templates" style={{ color: "#1d4ed8", fontWeight: "700", textDecoration: "none" }}>
                    Using Templates
                  </a>
                </li>
              </ul>
            </section>

            <section style={helpSectionNoDividerStyle}>
              <h3>3. Analyze the Data</h3>
              <p>
                Once records are saved, use the analysis pages to follow a person through time, review
                household members, compare nearby households, and check for possible duplicate records.
              </p>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/projects") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Working with Projects</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Organize related records together</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Projects are the foundation of how you organize your research in the app. They let
              you group related records together while still giving you the flexibility to search
              across everything you have collected.
            </p>

            <section style={helpSectionStyle}>
              <h3>Create as Many Projects as You Need</h3>
              <p>
                You can create unlimited projects to match the way you think about your data. For
                example, you might:
              </p>
              <ul>
                <li>Create a project for each surname, such as <strong>Dame</strong> or <strong>Dickinson</strong>.</li>
                <li>Organize by location, such as <strong>Vermont</strong> or <strong>Massachusetts</strong>.</li>
                <li>Separate research by time period or family branch.</li>
              </ul>
              <p>There is no limit. Use whatever structure makes your research easier to manage.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Search Across All Projects</h3>
              <p>
                Even though your data is organized into projects, you are never locked into just one.
                You can search:
              </p>
              <ul>
                <li>Within a single project.</li>
                <li>Across all projects at once.</li>
              </ul>
              <p>
                This makes it easy to spot connections, track individuals across locations, or find
                missing years in your research.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Switching and Viewing Projects</h3>
              <p>
                The currently selected project is displayed on every records view, so you always know
                where you are working.
              </p>
              <p>
                If needed, you can switch your view to show all data from all projects, giving you a
                complete picture of your research.
              </p>
              <ul>
                <li>
                  <strong>View Records by Year</strong> shows the most complete census data for each person
                  in the selected census year.
                </li>
                <li>
                  <strong>View Records by Project</strong> shows an abbreviated version of the census data,
                  which makes it useful as a quick overview.
                </li>
              </ul>
              <p>
                You can filter these pages by typing a name, location, or other text into the filter box.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Merging Projects</h3>
              <p>
                If two projects belong together, you can merge one project into another from the
                Projects box on the Home page.
              </p>
              <ul>
                <li>Select the project you want to move from.</li>
                <li>Choose the project you want to merge the data into.</li>
                <li>Click <strong>Merge Project</strong>.</li>
              </ul>
              <p>
                A useful strategy is to create a new temporary project before importing a large set
                of data. Import the records there first and review them.
              </p>
              <ul>
                <li>If the import does not look right, delete the temporary project and start over.</li>
                <li>If the import looks good, merge the temporary project into your existing project.</li>
              </ul>
              <p>
                After a merge, the first project is removed and its records become part of the project
                you selected as the destination.
              </p>
            </section>

            <section style={helpSectionNoDividerStyle}>
              <h3>Deleting a Project</h3>
              <p>If you no longer need a project, you can remove it:</p>
              <ul>
                <li>On the Home page in the Projects section, select the project you want to remove, then click <strong>Delete Selected Project</strong>.</li>
                <li>Deleting a project will also permanently remove all records within that project.</li>
              </ul>
              <p>
                Be sure you no longer need the data before deleting, as this action cannot be undone.
              </p>
              <p>
                To save your data, export a backup before deleting the project. You can always reimport later.
              </p>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
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
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Using Census Templates</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Census Templates make it easy to enter large amounts of census data quickly and
              consistently. Whether you prefer working in a spreadsheet or typing directly into the
              app, you can choose the method that works best for you.
            </p>

            <section style={helpSectionStyle}>
              <h3>Basic Workflow</h3>
              <ol>
                <li>Convert the census image into text. Often, using a spreadsheet helps.</li>
                <li>Check that you have the correct project chosen.</li>
                <li>
                  Choose the census year you want to enter. On the template page, copy/paste the data
                  from your spreadsheet or import it in CSV format.
                </li>
                <li>
                  Check the data to make sure it lines up with the table headings. If it does not,
                  click <strong>Clear All</strong>, fix the source data, then copy/paste or import again.
                </li>
                <li>
                  If everything lines up, click <strong>Add Filled Rows to Project</strong>. Your data
                  is now added to the project and ready for analysis.
                </li>
                <li>
                  To view what you entered, click <strong>View Census Records by Year</strong>. You can
                  edit individual records after they have been added.
                </li>
              </ol>
            </section>

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
              <p>The data is loaded directly into the template fields. Click <strong>Paste Data into Template</strong> to save your records to the project.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Enter Data Manually</h3>
              <p>To add data directly:</p>
              <ul>
                <li>Type or paste information into each field.</li>
                <li>Click <strong>Add Rows</strong> to add 5 blank rows to the bottom of the table.</li>
              </ul>
              <p>This is useful when working from a single census page or handwritten notes.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Clearing the Template</h3>
              <p>To remove all current data:</p>
              <ul>
                <li>Click <strong>Clear All</strong>.</li>
              </ul>
              <p>
                This clears the data from the template and doesn&apos;t affect your project. This is
                useful if you want to remove what you&apos;ve imported and bring in fresh data.
              </p>
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
              <h3>Saving Source Documents</h3>
              <p>
                For deeper research and verification, keep copies of your original census images or
                PDFs organized with your genealogy files.
              </p>
              <ul>
                <li>From the Home page, click <strong>Collect Census Images</strong>.</li>
                <li>Navigate to the image you want to include.</li>
                <li>
                  Enter the path and naming convention you want. See{" "}
                  <a href="#/help/sources-attachments">Sources and Attachments</a>.
                </li>
              </ul>
              <p>
                These source files are not attached to your Census Notebook records and are not saved
                inside the app. They stay in your local Sources folder.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Custom Templates</h3>
              <p>Custom templates give you flexibility on the data you collect.</p>
              <ul>
                <li>
                  Add your own templates for records that do not match the built-in census years,
                  such as state census records or military records.
                </li>
                <li>Create your own template if a built-in template does not fit your needs.</li>
                <li>Custom template buttons are automatically added to the Home page.</li>
              </ul>
              <p>
                <strong>Note:</strong> Custom templates are stored in your current browser on your
                current device. Opening Census Notebook in another browser, in incognito mode, or on
                another device will not show your templates or records.
              </p>
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
              <p>
                <strong>Hint:</strong> You can create a custom template for an existing census year
                if you are having issues matching the provided fields.
              </p>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/manual-records") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Adding Records Manually</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Type records directly into Census Notebook</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              You do not have to import a spreadsheet. If you are working from one census record,
              handwritten notes, or a small amount of data, you can type records in by hand.
            </p>

            <section style={helpSectionStyle}>
              <h3>Option 1: Use Add Record on the Home Page</h3>
              <p>
                Use <strong>Add Record to [project name]</strong> when you want to create one quick
                record without opening a full census template.
              </p>
              <ul>
                <li>Select or create the project first.</li>
                <li>Enter the year, name, location, page, and notes.</li>
                <li>Click <strong>Add Record</strong>.</li>
              </ul>
              <p>
                This is best for a single person, a quick note, or a record that does not need all the
                fields from a census-year template.
              </p>
            </section>

            <section style={helpSectionNoDividerStyle}>
              <h3>Option 2: Type Into a Census Template</h3>
              <p>
                Use a census-year template when you want the fields for that specific census year.
              </p>
              <ul>
                <li>Open the template for the census year you are using.</li>
                <li>Type information directly into the table cells.</li>
                <li>Click <strong>Add Rows</strong> if you need more blank rows.</li>
                <li>Click <strong>Add Filled Rows to Project</strong> when you are ready to save.</li>
              </ul>
              <p>
                This is best when you are entering a full household, multiple rows from a page, or data
                that should line up with the official census fields for that year.
              </p>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/modifying-records") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Modifying Records</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Fine-tune records after import</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              After you import your records, you can continue to fine-tune your data.
            </p>

            <section style={helpSectionNoDividerStyle}>
              <h3>Edit Imported Records</h3>
              <p>
                The easiest place to edit imported census fields is the{" "}
                <a href="#/records-by-year">View Census Records by Year</a> page.
              </p>
              <ul>
                <li>Choose the census year you want to review.</li>
                <li>Click the edit button for the record you want to change.</li>
                <li>Update any field that needs correction.</li>
                <li>Click <strong>Save</strong>.</li>
              </ul>
              <p>Edits automatically appear in other views.</p>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/import-scope") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>How Much Census Data Should You Import?</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Choose the amount of data that matches your research goal</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              When working with census records, one of the first decisions you will make is how much
              data to bring into Census Notebook. There is no single right answer. It depends on
              what you are trying to learn.
            </p>

            <section style={helpSectionStyle}>
              <h3>Option 1: Import the Entire Page</h3>
              <p>You can enter every household on a census page, not just your family.</p>
              <h4>Why this is useful</h4>
              <ul>
                <li>You capture neighbors and nearby families.</li>
                <li>You can see community patterns.</li>
                <li>You may discover relatives living nearby, in-laws or extended family, and familiar surnames that repeat across years.</li>
              </ul>
              <p><strong>Genealogy tip:</strong> neighbors are often just as important as family.</p>
              <h4>When to use this approach</h4>
              <ul>
                <li>You are trying to break through a brick wall.</li>
                <li>You suspect family connections nearby.</li>
                <li>You want to understand the community your ancestors lived in.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Option 2: Import Only Your Family</h3>
              <p>You can focus on just the household you care about.</p>
              <h4>Why this is useful</h4>
              <ul>
                <li>It keeps your data clean and focused.</li>
                <li>It makes it easier to track individuals across years.</li>
                <li>It makes it easier to compare ages, locations, and relationships.</li>
                <li>It is faster for data entry.</li>
              </ul>
              <p><strong>Best fit:</strong> this is ideal when you already know who you are researching.</p>
              <h4>When to use this approach</h4>
              <ul>
                <li>You are building a direct family timeline.</li>
                <li>You want to quickly analyze one lineage.</li>
                <li>You do not need surrounding context.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>A Balanced Approach</h3>
              <p>You do not have to choose just one method.</p>
              <p>A practical workflow is:</p>
              <ul>
                <li>Start by entering your family only.</li>
                <li>Then expand to include neighbors when needed.</li>
              </ul>
              <p>This lets you stay focused while still having the option to dig deeper.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Using Multiple Projects</h3>
              <p>
                Census Notebook lets you organize your work into projects, which makes it easy to
                use both approaches at once.
              </p>
              <h4>Example setup</h4>
              <ul>
                <li><strong>Project 1: Full Census Pages</strong> contains complete transcriptions for neighborhood and community analysis.</li>
                <li><strong>Project 2: Direct Family Lines</strong> contains only your ancestors for focused timeline tracking.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Search Across Everything</h3>
              <p>Even if your data is split across projects, you can:</p>
              <ul>
                <li>Search by name.</li>
                <li>Search by location.</li>
                <li>View results across all projects.</li>
              </ul>
              <p>This gives you both focused research and broader community context.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Why This Matters</h3>
              <p>The amount of data you import directly affects what you can discover:</p>
              <ul>
                <li><strong>More data</strong> gives you more context and unexpected connections.</li>
                <li><strong>Less data</strong> gives you faster, clearer analysis.</li>
              </ul>
              <p>The key is to match your approach to your goal.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Practical Tip</h3>
              <p>
                If you are unsure, start small with your family, then expand later. You can always
                add more data, but starting with everything can feel overwhelming.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Bottom Line</h3>
              <ul>
                <li>Import entire pages when you want context.</li>
                <li>Import individual families when you want focus.</li>
                <li>Use projects to organize both.</li>
                <li>Use search to connect everything.</li>
              </ul>
              <p>Census Notebook is designed to support both styles, so you can work the way genealogists actually research.</p>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/cleaning-data") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Tips for Cleaning Up Data Before Import</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Prepare your census data before importing</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Before importing census data into Census Notebook, it is worth taking a little time to
              clean and organize your data. This helps prevent errors, improves search results,
              reduces frustration, and makes your analysis much more reliable.
            </p>

            <section style={helpSectionStyle}>
              <h3>1. Start with the Correct Template</h3>
              <p>Each census year collects different information.</p>
              <ul>
                <li>Download the template for the specific census year you are working with.</li>
                <li>Open it in your spreadsheet program, such as Excel or Google Sheets.</li>
              </ul>
              <p>This ensures your data lines up correctly when you import it.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>2. Convert the Census Image to Text (OCR)</h3>
              <p>
                If your census record is an image, you will need to convert it into editable text.
                This process is called OCR, or Optical Character Recognition.
              </p>
              <h4>Common Ways to Convert an Image to Text</h4>
              <ul>
                <li><strong>Built-in tools:</strong> Mac Preview or Windows Snipping Tool text actions.</li>
                <li><strong>Online OCR tools:</strong> upload an image and copy the extracted text.</li>
                <li><strong>Mobile apps:</strong> scan documents and extract text using your phone.</li>
                <li><strong>AI transcription tools:</strong> paste the image and ask for structured table output.</li>
                <li><strong>Manual transcription:</strong> type directly from the image, which is slower but often most accurate for handwritten pages.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>3. Paste Into a Spreadsheet and Clean It</h3>
              <p>Once you have text, paste it into your template spreadsheet and make sure:</p>
              <ul>
                <li>One person is on each row.</li>
                <li>Each field is in the correct column.</li>
              </ul>
              <h4>Things to Fix</h4>
              <ul>
                <li>Misspelled names, or keep original spelling but be consistent.</li>
                <li>Incorrect ages or numbers from OCR errors.</li>
                <li>Misaligned columns.</li>
                <li>Extra spaces or line breaks.</li>
              </ul>
              <p><strong>Tip:</strong> Census handwriting often confuses OCR, so always review carefully.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>4. Add Location and Page Information</h3>
              <p>
                The first column in each template identifies the location where the census occurred.
                The recommended format for the Location field is:
              </p>
              <code style={codeBlockStyle}>State, County, Town/City</code>
              <p>
                This will usually be the same for everyone on each census sheet. The page number is
                also usually the same for everyone on the sheet and is helpful when trying to locate
                the name on the original document.
              </p>
              <p>This step allows you to:</p>
              <ul>
                <li>Trace records back to the original source.</li>
                <li>Group households correctly.</li>
                <li>Filter by location in Census Notebook.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>5. Keep Data Consistent</h3>
              <p>Consistency is more important than perfection.</p>
              <ul>
                <li>Use the same format for locations, such as <strong>Maine, Cumberland, Falmouth</strong>.</li>
                <li>Keep abbreviations consistent, such as choosing either <strong>M</strong> or <strong>Male</strong>.</li>
                <li>Leave unknown values blank, or use a standard value like <strong>[unknown]</strong> or <strong>?</strong>.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>6. Watch for Common OCR Problems</h3>
              <p>OCR often makes predictable mistakes, such as:</p>
              <ul>
                <li><strong>Maine</strong> becoming <strong>Me</strong> or <strong>MaIne</strong>.</li>
                <li><strong>Farmer</strong> becoming <strong>Fanner</strong>.</li>
                <li>Numbers being confused, such as <strong>1</strong> and <strong>7</strong>, or <strong>0</strong> and <strong>O</strong>.</li>
              </ul>
              <p>Review names, ages, and occupations especially carefully.</p>
            </section>

            <section style={helpSectionStyle}>
              <h3>7. Verify Households</h3>
              <p>Before importing:</p>
              <ul>
                <li>Make sure family members are grouped correctly.</li>
                <li>Check relationship fields, especially in 1880 and later.</li>
                <li>Confirm no one is accidentally split across rows.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>8. Save and Import</h3>
              <p>When your data looks correct:</p>
              <ul>
                <li>Save your spreadsheet, export it as CSV, and import it into Census Notebook.</li>
                <li>Or copy and paste into the paste box, then click <strong>Paste Data into Template</strong>.</li>
              </ul>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/sources-attachments") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Sources & Attachments</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>Keep census images in your own source folder</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Census Notebook is designed to keep your data local. Large source images and PDFs are
              best stored in a folder on your own computer, external drive, or cloud folder that you control.
            </p>

            <section style={helpSectionStyle}>
              <h3>Create a Sources Folder</h3>
              <p>Create one folder for census source files, then organize it by year and place.</p>
              <p>
                <strong>Folder pattern:</strong>{" "}
                <code style={{ background: "#dbeafe", color: "#1e3a8a", padding: "4px 8px", borderRadius: "6px", fontWeight: "700" }}>
                  Sources / Year / State / County / Town
                </code>
              </p>
              <code style={codeBlockStyle}>{`Census Notebook Sources/
  1920/
    Maine/
      Cumberland/
        Standish/`}</code>
            </section>

            <section style={helpSectionStyle}>
              <h3>Name Files Consistently</h3>
              <p>Use a filename that starts with the census year and location, then add the person or household name.</p>
              <code style={codeBlockStyle}>{`1920-Maine-Cumberland-Standish-Fuller-Alvin.jpg
1920-Maine-Cumberland-Standish-Fuller-Alvin-page-12.pdf`}</code>
              <p>
                The Collect Census Images page shows a suggested filename based on the year, place,
                and person details you enter.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Attach Files While You Work</h3>
              <p>
                On the Collect Census Images page, click <strong>Choose Sources Folder</strong>, then use{" "}
                <strong>Attach Images/PDFs</strong>. Census Notebook copies each selected file into
                that folder structure and renames it using the suggested source filename.
              </p>
              <ul>
                <li>Supported formats: JPG, PNG, and PDF.</li>
                <li>If a filename already exists, Census Notebook adds a number such as <strong>-2</strong>.</li>
                <li>Include your source folder in your normal backup routine.</li>
                <li>This folder access works in browsers that support local folder permissions, such as Chrome or Edge.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Why Store Images Outside the App?</h3>
              <ul>
                <li>Census images and PDFs can be very large.</li>
                <li>Your app backups stay smaller and easier to move.</li>
                <li>You can sync source files with iCloud, Dropbox, Google Drive, or an external drive.</li>
                <li>You remain in control of your own records and files.</li>
              </ul>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
        </div>
      </div>
    );
  }

  if (currentPage === "#/help/known-limitations") {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <header style={headerStyle}>
            <p style={{ margin: 0, color: "#6b7280", fontWeight: "700", textTransform: "uppercase" }}>
              Help topic
            </p>
            <h1 style={{ fontSize: "46px", margin: "10px 0 16px" }}>Known Limitations</h1>
            {renderHelpTopicControls()}
          </header>

          <article style={helpArticleStyle}>
            <h2 style={helpHeadingStyle}>What to know before relying on Census Notebook</h2>
            <p style={{ color: "#4b5563", fontSize: "18px", marginTop: 0 }}>
              Census Notebook is local-first, which keeps your research private, but it also means
              you are responsible for backups and source-file organization.
            </p>

            <section style={helpSectionStyle}>
              <h3>Local Storage Is Device-Specific</h3>
              <ul>
                <li>Your project data is stored on the device and browser you are using.</li>
                <li>Using a different browser or computer will not automatically show the same data.</li>
                <li>Clearing browser data can remove your Census Notebook data.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Backups Are Your Responsibility</h3>
              <ul>
                <li>Use <strong>Export Backup</strong> regularly.</li>
                <li>Keep backup files somewhere safe, such as an external drive or cloud folder.</li>
                <li>Use <strong>Import Backup</strong> to restore data on another browser or device.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Ways You Could Lose Data</h3>
              <p>
                Census Notebook stores your project data in your browser on the device you are using.
                This keeps your research private, but it also means you are responsible for protecting
                your data.
              </p>
              <p>You could lose data if you:</p>
              <ul>
                <li>Clear browser data, cookies, site data, cache, or history.</li>
                <li>Use a different browser, browser profile, computer, or device.</li>
                <li>Work in a private or incognito browser window.</li>
                <li>Uninstall or reset your browser.</li>
                <li>Use a computer that automatically clears browser storage.</li>
                <li>Accidentally delete records or projects.</li>
                <li>Import an older backup over newer work.</li>
              </ul>
              <p>
                To protect your work, export backups regularly and keep copies somewhere safe, such as
                your Documents folder, an external drive, or cloud storage you control.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Source Images Are Separate</h3>
              <ul>
                <li>App backups do not include census images or PDFs.</li>
                <li>Source files are copied to the Sources folder you choose.</li>
                <li>Back up your Sources folder separately from your app data backup.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Folder Saving Depends on the Browser</h3>
              <ul>
                <li>Choosing a local Sources folder requires browser support for local folder permissions.</li>
                <li>This works best in Chrome or Edge on HTTPS or localhost.</li>
                <li>Some browsers may only allow previewing files, not copying them into a folder.</li>
              </ul>
            </section>

            <section style={helpSectionStyle}>
              <h3>Analysis Depends on Entered Fields</h3>
              <ul>
                <li>Person Timeline, Neighbors, and Household depend on consistent names and fields.</li>
                <li>Neighbors works best when rows are imported in census page order.</li>
                <li>Dwelling and family number analysis depends on those fields being present.</li>
                <li>OCR or AI transcription will contain errors that require manual review.</li>
              </ul>
            </section>
          </article>
          <CopyrightFooter actionMessage={recordActionMessage} />
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
            {renderHelpTopicControls()}
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
          <CopyrightFooter actionMessage={recordActionMessage} />
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
            {renderHelpTopicControls()}
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
                <li>
                  Mac: Preview can select text from an image if text recognition is available.
                  Make sure <strong>System Settings</strong> &rarr; <strong>General</strong> &rarr;{" "}
                  <strong>Language &amp; Region</strong> &rarr; <strong>Live Text</strong> is enabled.
                </li>
                <li>Windows: Snipping Tool can extract text on newer versions.</li>
                <li>
                  AI tools such as ChatGPT or Google Gemini can transcribe an uploaded image. Upload
                  the image, then use the{" "}
                  <a
                    href="#/help/census-image-text"
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById("prompt")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    style={{ color: "#1d4ed8", fontWeight: "700", textDecoration: "none" }}
                  >
                    prompt
                  </a>{" "}
                  below.
                </li>
              </ul>
              <p>Upload your image, and the tool will give you editable text.</p>
              <p>
                <strong>Note:</strong> Census images are often handwritten, so OCR may not be
                perfect. You will still need to review and fix errors.
              </p>
            </section>

            <section style={helpSectionStyle}>
              <h3>Using Ancestry and Excel</h3>
              <ul>
                <li>
                  Open the census image in Ancestry and click <strong>View Text</strong>.
                  <img
                    src="/ancestry-view-text.png"
                    alt="Ancestry image viewer toolbar with the View Text button indicated"
                    style={{
                      display: "block",
                      maxWidth: "360px",
                      width: "100%",
                      height: "auto",
                      marginTop: "10px",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  />
                </li>
                <li>
                  Select the data you want. Capturing the entire page can make it easier to find
                  neighbors and nearby relatives.
                </li>
                <li>
                  In Excel, use <strong>Paste Special</strong> &rarr; <strong>Paste Special</strong> &rarr; <strong>Text</strong>. This
                  automatically pastes the data into separate cells.
                </li>
                <li>After checking and correcting the data, copy and paste from Excel into Census Notebook.</li>
              </ul>
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
              <h3 id="prompt">AI Prompt</h3>
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
          <CopyrightFooter actionMessage={recordActionMessage} />
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
            <p>
              Census Notebook helps you turn scattered census records into
              <br />
              organized, searchable timelines for genealogy research.
            </p>
            <p>
              Census Notebook does not collect your data to the cloud.
            </p>
          </div>
          <p style={{ marginTop: "16px", color: apiConnected ? "#047857" : "#92400e", fontWeight: "700" }}>
            {statusMessage}
          </p>
          <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap", marginTop: "10px" }}>
            <a
              href="#/help/how-it-works"
              style={{ ...lightButtonStyle, display: "inline-block", fontSize: "13px", padding: "8px 12px", textDecoration: "none" }}
            >
              How Census Notebook Works
            </a>
          </div>
        </header>

        <main style={mainStyle}>
          <aside style={sidebarStyle}>
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

              <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px solid #e5e7eb" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", color: "#374151", fontWeight: "700", fontSize: "13px" }}>
                  Merge selected project into
                  <select
                    value={validMergeTargetProjectId}
                    onChange={(event) => setMergeTargetProjectId(event.target.value)}
                    disabled={!activeProject || mergeTargetProjects.length === 0}
                    style={{ ...inputStyle, width: "100%" }}
                  >
                    <option value="">Choose project</option>
                    {mergeTargetProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={mergeActiveProject}
                  disabled={!activeProject || !validMergeTargetProjectId}
                  style={{
                    ...lightButtonStyle,
                    width: "100%",
                    marginTop: "10px",
                    color: activeProject && validMergeTargetProjectId ? "#1d4ed8" : "#9ca3af",
                    cursor: activeProject && validMergeTargetProjectId ? "pointer" : "not-allowed",
                  }}
                >
                  Merge Project
                </button>
              </div>
            </section>

            <nav style={cardStyle}>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <a style={navLinkStyle} href="#/project-data">View Records by Project</a>
                <a style={navLinkStyle} href="#/records-by-year">View Records by Year</a>
                <a style={navLinkStyle} href="#/favorites">View Favorites</a>
                <a style={navLinkStyle} href={activeProject ? `#/notes?project=${activeProject.id}` : "#/notes"}>Notes</a>
                <a style={navLinkStyle} href="#/collect-census-images">Collect Census Images</a>
                <a style={navLinkStyle} href="#/help">Help</a>
              </div>
            </nav>

            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Analysis</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <a
                  href="#/analysis/person-timeline"
                  style={{ ...buttonStyle, display: "block", textDecoration: "none", textAlign: "center" }}
                >
                  Person Timeline
                </a>
                <a
                  href="#/analysis/neighbors"
                  style={{ ...buttonStyle, display: "block", textDecoration: "none", textAlign: "center" }}
                >
                  Neighbors
                </a>
                <a
                  href="#/analysis/household"
                  style={{ ...buttonStyle, display: "block", textDecoration: "none", textAlign: "center" }}
                >
                  Household
                </a>
                <a
                  href="#/analysis/duplicates"
                  style={{ ...buttonStyle, display: "block", textDecoration: "none", textAlign: "center" }}
                >
                  Duplicates
                </a>
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Resources</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <a
                  href="https://www.cyndislist.com/"
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...navLinkStyle, display: "block" }}
                >
                  Cyndi&apos;s List
                </a>
                <a
                  href="https://www.familysearch.org/"
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...navLinkStyle, display: "block" }}
                >
                  FamilySearch
                </a>
              </div>
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
              <p style={{ margin: "0 0 12px", color: "#4b5563" }}>
                Click a year to use the built-in template, or create your own.
              </p>
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
                style={{
                  ...buttonStyle,
                  display: "inline-block",
                  fontSize: "13.3333px",
                  marginTop: "14px",
                  textDecoration: "none",
                  textAlign: "center",
                }}
              >
                Create a Template
              </a>
            </section>

            <section id="search" style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                <h2 style={sectionTitleStyle}>Search All Projects</h2>

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSearchResultsCleared(false);
                      setSearchResultLimit(HOME_SEARCH_RESULT_LIMIT);
                    }}
                    placeholder="Search name, place, note, project..."
                    style={{ ...inputStyle, minWidth: "280px" }}
                  />

                  <select
                    value={yearFilter}
                    onChange={(e) => {
                      setYearFilter(e.target.value);
                      setSearchResultsCleared(false);
                      setSearchResultLimit(HOME_SEARCH_RESULT_LIMIT);
                    }}
                    style={inputStyle}
                  >
                    <option value="all">All years</option>
                    {years.map((year) => (
                      <option key={year} value={year}>{year}</option>
                    ))}
                  </select>

                  <label style={{ display: "flex", alignItems: "center", gap: "8px", ...inputStyle }}>
                    <input
                      type="checkbox"
                      checked={showBookmarkedOnly}
                      onChange={(e) => {
                        setShowBookmarkedOnly(e.target.checked);
                        setSearchResultsCleared(false);
                        setSearchResultLimit(HOME_SEARCH_RESULT_LIMIT);
                      }}
                    />
                    Favorites
                  </label>

                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setYearFilter("all");
                      setShowBookmarkedOnly(false);
                      setSearchResultsCleared(true);
                      setSearchResultLimit(HOME_SEARCH_RESULT_LIMIT);
                      cancelEditingSearchRecord();
                    }}
                    style={lightButtonStyle}
                  >
                    Clear Results
                  </button>
                </div>
              </div>

              <div style={{ overflowX: "auto", marginTop: "18px" }}>
                <table style={{ width: "100%", minWidth: "900px", borderCollapse: "collapse", fontSize: "14px" }}>
                  <thead>
                    <tr style={{ background: "#f3f4f6" }}>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Year</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Name</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Location</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Page</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>Project</th>
                      <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e5e7eb", width: "150px" }}>Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {limitedSearchRecords.map((record) => {
                      const isEditing = editingSearchRecordId === record.id;

                      return (
                        <tr key={record.id} style={{ background: record.highlighted ? "#fef9c3" : "white" }}>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.year}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, year: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "90px" }}
                              />
                            ) : (
                              record.year
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", fontWeight: "700" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.name}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, name: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "180px" }}
                              />
                            ) : (
                              <a
                                href={`#/project-data?project=${record.projectId}&record=${record.id}`}
                                style={{ color: "#1d4ed8", textDecoration: "none" }}
                              >
                                {record.name || "Unnamed record"}
                              </a>
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.location}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, location: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "160px" }}
                              />
                            ) : (
                              record.location
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
                            {isEditing ? (
                              <input
                                value={editingSearchRecordDraft.household}
                                onChange={(event) =>
                                  setEditingSearchRecordDraft((prev) => ({ ...prev, household: event.target.value }))
                                }
                                style={{ ...inputStyle, minWidth: "160px" }}
                              />
                            ) : (
                              record.household
                            )}
                          </td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>{record.projectName}</td>
                          <td style={{ padding: "12px", borderBottom: "1px solid #e5e7eb", width: "180px" }}>
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                              {isEditing ? (
                                <>
                                  <button
                                    onClick={() => saveEditingSearchRecord(record.projectId, record.id)}
                                    style={buttonStyle}
                                  >
                                    Save
                                  </button>
                                  <button onClick={cancelEditingSearchRecord} style={lightButtonStyle}>
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => startEditingSearchRecord(record)}
                                    aria-label="Edit record"
                                    title="Edit"
                                    style={actionButtonStyle}
                                  >
                                    ✎
                                  </button>
                                  <button
                                    onClick={() => updateRecordAction(record.projectId, record.id, { bookmarked: !record.bookmarked }, "Updating favorite...")}
                                    aria-label={record.bookmarked ? "Remove favorite" : "Mark as favorite"}
                                    title={record.bookmarked ? "Remove favorite" : "Favorite"}
                                    style={actionButtonStyle}
                                  >
                                    {record.bookmarked ? "★" : "☆"}
                                  </button>
                                  <button
                                    onClick={() => updateRecordAction(record.projectId, record.id, { highlighted: !record.highlighted }, "Updating highlight...")}
                                    aria-label={record.highlighted ? "Remove highlight" : "Highlight record"}
                                    title={record.highlighted ? "Remove highlight" : "Highlight"}
                                    style={highlightActionButtonStyle(record.highlighted)}
                                  >
                                    H
                                  </button>
                                  <button
                                    onClick={() => deleteRecord(record.projectId, record.id)}
                                    aria-label="Delete record"
                                    title="Delete"
                                    style={{ ...actionButtonStyle, color: "#dc2626" }}
                                  >
                                    X
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {hiddenSearchRecordCount > 0 && (
                      <tr>
                        <td colSpan="6" style={{ padding: "18px", textAlign: "center", color: "#4b5563", fontWeight: "700" }}>
                          <div style={{ display: "flex", justifyContent: "center", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                            <span>
                              Showing first {limitedSearchRecords.length} of {visibleSearchRecords.length} matching records.
                            </span>
                            <button
                              type="button"
                              onClick={() => setSearchResultLimit((prev) => prev + HOME_SEARCH_RESULT_LIMIT)}
                              style={lightButtonStyle}
                            >
                              Show More
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}

                    {visibleSearchRecords.length === 0 && (
                      <tr>
                        <td colSpan="6" style={{ padding: "28px", textAlign: "center", color: "#6b7280" }}>
                          {searchResultsCleared ? "Search results cleared." : "No records found."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Backup</h2>
              <p style={{ color: "#4b5563" }}>
                Export or import your local Census Notebook data as a JSON backup file.
              </p>
              <p style={{ color: "#92400e", fontWeight: "700" }}>
                Your data is stored on this device. Export backups regularly.
              </p>
              <p style={{ color: "#4b5563", fontSize: "14px" }}>
                After exporting, check your Downloads folder for the backup file.
              </p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
                <button onClick={exportJson} style={buttonStyle}>Export Backup</button>
                <label style={{ ...lightButtonStyle, display: "inline-block", fontSize: "13.3333px" }}>
                  Import Backup
                  <input type="file" accept=".json,application/json" onChange={importBackupFile} style={{ display: "none" }} />
                </label>
              </div>
            </section>

          </section>
        </main>
        <CopyrightFooter actionMessage={recordActionMessage} />
      </div>
    </div>
  );
}
