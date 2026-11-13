import {
  API_BASE,
  apiUrl,
  clearNativeToken,
  getNativeToken,
  isNativeApp,
  setNativeToken,
  setUploadToken
} from './runtime';

async function request(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const nativeToken = getNativeToken();
  if (isNativeApp) headers['X-Cordia-Client'] = 'native';
  if (nativeToken) headers.Authorization = `Bearer ${nativeToken}`;
  let payload;
  if (isForm) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(apiUrl(path), {
    method,
    headers,
    body: payload,
    credentials: API_BASE ? 'include' : 'same-origin'
  });

  let data = null;
  if (response.status !== 204) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401) clearNativeToken();
    const error = new Error((data && data.error) || 'Something went wrong.');
    error.status = response.status;
    // Machine-readable reasons (e.g. STORAGE_FULL on a 413) ride along so
    // callers can react without matching on prose.
    if (data && data.code) error.code = data.code;
    throw error;
  }

  // Only the auth routes issue session tokens. Interaction endpoints return a
  // "token" too — the single-use interaction token — and promoting that to the
  // session would sign the user out on the very next request.
  if (data && data.token && path.startsWith('/api/auth/')) setNativeToken(data.token);
  if (data && data.uploadToken) setUploadToken(data.uploadToken);
  return data;
}

const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/api/upload', { method: 'POST', body: form, isForm: true });
  },
  uploadFiles: (path, files) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    return request(path, { method: 'POST', body: form, isForm: true });
  },
  download: async (path) => {
    const headers = {};
    const nativeToken = getNativeToken();
    if (isNativeApp) headers['X-Cordia-Client'] = 'native';
    if (nativeToken) headers.Authorization = `Bearer ${nativeToken}`;
    const response = await fetch(apiUrl(path), {
      headers,
      credentials: API_BASE ? 'include' : 'same-origin'
    });
    if (!response.ok) {
      if (response.status === 401) clearNativeToken();
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      const error = new Error((data && data.error) || 'Could not download this file.');
      error.status = response.status;
      throw error;
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/i.exec(disposition);
    return {
      blob: await response.blob(),
      filename: match ? match[1] : 'cordia-export.json'
    };
  }
};

export default api;
