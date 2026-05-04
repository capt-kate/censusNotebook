const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `API request failed: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export async function fetchProjects() {
  return request("/projects");
}

export async function createProject(name) {
  return request("/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteProject(projectId) {
  return request(`/projects/${projectId}`, {
    method: "DELETE",
  });
}

export async function createRecord(projectId, record) {
  return request(`/projects/${projectId}/records`, {
    method: "POST",
    body: JSON.stringify(record),
  });
}

export async function updateRecord(recordId, changes) {
  return request(`/records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export async function deleteRecord(recordId) {
  return request(`/records/${recordId}`, {
    method: "DELETE",
  });
}
