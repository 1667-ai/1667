import type {
  DesktopAuthPrompt,
  DesktopProjectSnapshot
} from "./renderer-shell-contract.js";
import type { RendererActions, RendererState } from "./renderer-model.js";

type Child = Node | string;

export function renderLauncher(state: RendererState, actions: RendererActions): HTMLElement {
  const page = node("main", "launcher-page");
  const masthead = node("header", "launcher-masthead");
  const brand = node("div", "launcher-brand", node("span", "launcher-mark", "✦"), node("span", "launcher-name", "1667"));
  masthead.append(brand, node("span", "launcher-label", "desktop writing studio"));
  if (state.project?.open === true) {
    masthead.append(button("launcher-small", "Back to story", () => actions.showProjects(false)));
  }

  const content = node("div", "launcher-content");
  const intro = node("section", "launcher-intro",
    node("span", "eyebrow", "Project launcher"),
    node("h1", "", state.project === null ? "Open a room for the next sentence." : displayDirectory(state.project.directory)),
    node("p", "", state.project === null
      ? "Choose a project folder to open its stories, settings, and local vault."
      : state.project.open
        ? "The project is ready."
        : "This project is sealed. Unlock it to continue."),
    state.project === null ? "" : node("p", "launcher-path", state.project.root),
    state.launcherError === null ? "" : node("p", "launcher-error", state.launcherError)
  );
  content.append(intro);

  if (state.project !== null && !state.project.open) {
    content.append(renderVault(state.project, state, actions));
  } else {
    content.append(renderProjectChoices(state, actions));
  }
  content.append(renderAccount(state, actions), renderUpdater(state, actions));
  if (state.authPrompt !== null) content.append(renderAuthPrompt(state, state.authPrompt.prompt, state.authPrompt.interactionId, actions));
  if (state.authMessage !== null) {
    const authMessage = node("div", "launcher-auth-message", node("span", "launcher-auth-copy", state.authMessage));
    for (const link of state.authLinks) {
      const anchor = document.createElement("a");
      anchor.className = "button launcher-auth-link";
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.textContent = link.label;
      authMessage.append(anchor);
    }
    content.append(authMessage);
  }
  page.append(masthead, content);
  return page;
}

function renderProjectChoices(state: RendererState, actions: RendererActions): HTMLElement {
  const panel = node("section", "launcher-panel project-panel");
  panel.append(node("div", "launcher-panel-heading", node("span", "eyebrow", "Projects"), node("h2", "", "Choose a project")));
  const controls = node("div", "launcher-actions");
  controls.append(
    button("launcher-primary", "Open project folder", () => void openProject(actions)),
    button("launcher-secondary", "Create project", () => void createProject(actions)),
    button("launcher-secondary", "Adopt existing project", () => void adoptProject(actions)),
    state.project?.open === true
      ? button("launcher-secondary", "Reveal folder", actions.revealProject)
      : ""
  );
  if (state.launcherBusy) controls.querySelectorAll("button").forEach((entry) => { (entry as HTMLButtonElement).disabled = true; });
  panel.append(controls);
  if (state.recentProjects.length > 0) {
    const recent = node("div", "recent-projects", node("span", "eyebrow", "Recent"));
    for (const project of state.recentProjects) {
      const recentButton = button("recent-project", node("strong", "", project.directory), () => {
        void actions.shellRequest({ type: "project.open", root: project.root });
      }, node("span", "recent-project-path", project.root));
      recentButton.dataset.preserve = `recent:${project.root}`;
      recent.append(recentButton);
    }
    panel.append(recent);
  }
  return panel;
}

function renderVault(project: DesktopProjectSnapshot, state: RendererState, actions: RendererActions): HTMLElement {
  const panel = node("section", "launcher-panel vault-panel");
  const form = document.createElement("form");
  form.className = "launcher-form";
  const password = document.createElement("input");
  password.type = "password";
  password.placeholder = "Vault password";
  password.autocomplete = "current-password";
  password.required = true;
  password.className = "launcher-input";
  password.dataset.preserve = "vault-password";
  password.value = state.drafts["vault-password"] ?? "";
  password.setAttribute("aria-label", "Vault password");
  password.addEventListener("input", () => actions.setDraft("vault-password", password.value));
  const submit = button("launcher-primary", "Unlock project", () => {
    password.focus({ preventScroll: true });
    actions.setDraft("vault-password", password.value);
    void actions.shellRequest({ type: "vault.unlock", password: password.value });
  });
  const unseal = button("launcher-secondary", "Unseal permanently", () => {
    password.focus({ preventScroll: true });
    actions.setDraft("vault-password", password.value);
    void actions.shellRequest({ type: "vault.unseal", password: password.value });
  });
  submit.disabled = state.launcherBusy;
  unseal.disabled = state.launcherBusy;
  form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
  form.append(password, node("div", "launcher-vault-actions", submit, unseal));
  panel.append(node("div", "launcher-panel-heading", node("span", "eyebrow", "Vault"), node("h2", "", `Unlock ${displayDirectory(project.directory)}`), node("p", "launcher-path", project.root)), form);
  return panel;
}

function renderAccount(state: RendererState, actions: RendererActions): HTMLElement {
  const panel = node("section", "launcher-panel account-panel");
  const heading = node("div", "launcher-panel-heading", node("span", "eyebrow", "Accounts"), node("h2", "", "Subscription access"));
  const rows = node("div", "account-list");
  const statuses = new Map(state.authStatuses.map((status) => [status.provider, status]));
  for (const provider of ["chatgpt", "claude"] as const) {
    const status = statuses.get(provider);
    const signedIn = status?.status.startsWith("signed in") === true;
    const accountAction = signedIn
      ? button("launcher-small", "Sign out", () => void actions.shellRequest({ type: "auth.logout", provider }))
      : button("launcher-small", "Sign in", () => void actions.shellRequest({ type: "auth.login", provider }));
    accountAction.disabled = state.launcherBusy;
    const row = node("div", "account-row",
      node("div", "account-copy", node("strong", "", status?.label ?? (provider === "chatgpt" ? "ChatGPT" : "Claude")), node("span", "account-status", status?.status ?? "status unavailable")),
      accountAction
    );
    rows.append(row);
  }
  panel.append(heading, rows);
  return panel;
}

function renderUpdater(state: RendererState, actions: RendererActions): HTMLElement {
  const panel = node("section", "launcher-panel updater-panel");
  const updater = state.updater;
  const message = updaterMessage(updater);
  const channel = document.createElement("select");
  channel.className = "launcher-input updater-channel";
  channel.dataset.preserve = "updater-channel";
  channel.setAttribute("aria-label", "Update channel");
  for (const value of ["stable", "beta"] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "stable" ? "Stable channel" : "Beta channel";
    option.selected = (updater?.channel ?? "stable") === value;
    channel.append(option);
  }
  channel.addEventListener("change", () => {
    if (state.launcherBusy) {
      channel.value = updater?.channel ?? "stable";
      return;
    }
    actions.shellRequest({ type: "updater.channel", channel: channel.value === "beta" ? "beta" : "stable" });
  });
  const controls = node("div", "launcher-actions",
    channel,
    button("launcher-small", updater?.state === "checking" ? "Checking…" : "Check for updates", () => void actions.shellRequest({ type: "updater.check" })),
    updater?.state === "downloaded" ? button("launcher-primary", "Install update", () => void actions.shellRequest({ type: "updater.install" })) : ""
  );
  controls.querySelectorAll("button").forEach((entry) => { (entry as HTMLButtonElement).disabled = state.launcherBusy; });
  const activePreserveKey = document.activeElement instanceof HTMLElement
    ? document.activeElement.dataset.preserve
    : undefined;
  channel.disabled = state.launcherBusy && activePreserveKey !== "updater-channel";
  panel.append(node("div", "launcher-panel-heading", node("span", "eyebrow", "Desktop"), node("h2", "", "Updates")), node("p", "updater-message", message), controls);
  return panel;
}

function updaterMessage(updater: RendererState["updater"]): string {
  if (updater === null) return "Check for a stable desktop update.";
  if (updater.message !== null && updater.message.trim().length > 0) return updater.message;
  const version = updater.version ?? "the latest version";
  switch (updater.state) {
    case "checking": return `Checking the ${updater.channel} channel…`;
    case "available": return `Update ${version} is available. Downloading now.`;
    case "downloading": return `Downloading update ${version}…`;
    case "downloaded": return `Update ${version} is ready to install.`;
    case "not-available": return `You have the latest ${updater.channel} release.`;
    case "error": return `The ${updater.channel} update check failed.`;
    default: return `Check for a ${updater.channel} desktop update.`;
  }
}

function renderAuthPrompt(state: RendererState, prompt: DesktopAuthPrompt, interactionId: string, actions: RendererActions): HTMLElement {
  const panel = node("section", "launcher-panel auth-prompt");
  const form = document.createElement("form");
  form.className = "launcher-form";
  const control = prompt.type === "select" ? document.createElement("select") : document.createElement("input");
  control.className = "launcher-input";
  control.setAttribute("aria-label", prompt.message);
  if (prompt.type === "select") {
    const select = control as HTMLSelectElement;
    for (const optionData of prompt.options) {
      const option = document.createElement("option");
      option.value = optionData.id;
      option.textContent = optionData.description === undefined ? optionData.label : `${optionData.label} · ${optionData.description}`;
      select.append(option);
    }
  } else {
    const input = control as HTMLInputElement;
    input.type = prompt.type === "secret" ? "password" : "text";
    input.placeholder = prompt.placeholder ?? "";
    input.autocomplete = prompt.type === "secret" ? "one-time-code" : "off";
  }
  control.value = state.authPromptValue || (prompt.type === "select" ? prompt.options[0]?.id ?? "" : "");
  const submit = button("launcher-primary", "Continue", () => {
    void actions.shellRequest({ type: "auth.promptResponse", interactionId, value: control.value });
  });
  const cancel = button("launcher-secondary", "Cancel", () => {
    void actions.shellRequest({ type: "auth.cancel", interactionId });
  });
  control.dataset.preserve = `auth-prompt:${interactionId}`;
  control.addEventListener("input", () => actions.setAuthPromptValue(control.value));
  control.addEventListener("change", () => actions.setAuthPromptValue(control.value));
  form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
  form.append(node("p", "auth-prompt-message", prompt.message), control, node("div", "launcher-actions", submit, cancel));
  panel.append(node("div", "launcher-panel-heading", node("span", "eyebrow", "Sign in"), node("h2", "", "Provider request")), form);
  return panel;
}

async function openProject(actions: RendererActions): Promise<void> {
  const path = await chooseDirectory(actions, {
    title: "Open project",
    message: "Choose the project folder to open."
  });
  if (path !== null) await actions.shellRequest({ type: "project.open", root: path });
}

async function createProject(actions: RendererActions): Promise<void> {
  const path = await chooseDirectory(actions, {
    title: "Create project",
    message: "Choose the folder for the new project."
  });
  if (path !== null) await actions.shellRequest({ type: "project.create", root: path });
}

async function adoptProject(actions: RendererActions): Promise<void> {
  const source = await chooseDirectory(actions, {
    title: "Choose source folder",
    message: "Choose the existing 1667 data folder to adopt."
  });
  if (source === null) return;
  const projectRoot = await chooseDirectory(actions, {
    title: "Choose destination folder",
    message: "Choose the folder that will own the project."
  });
  if (projectRoot !== null) await actions.shellRequest({ type: "project.adopt", source, projectRoot });
}

async function chooseDirectory(
  actions: RendererActions,
  options: { readonly title: string; readonly message: string }
): Promise<string | null> {
  const response = await actions.shellRequest({ type: "dialog.directory", ...options });
  return response.ok && response.result.type === "dialog" ? response.result.paths[0] ?? null : null;
}

function button(className: string, label: string | HTMLElement, action: () => void, ...children: Child[]): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `button ${className}`;
  if (typeof label === "string") element.append(document.createTextNode(label));
  else element.append(label);
  for (const child of children) element.append(typeof child === "string" ? document.createTextNode(child) : child);
  element.addEventListener("click", action);
  return element;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  for (const child of children) element.append(typeof child === "string" ? document.createTextNode(child) : child);
  return element;
}

function displayDirectory(directory: string): string {
  const normalized = directory.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || normalized;
}
