import { useEffect, useState } from "react";
import { AuthSettingsWriteScope, type VoiceTranscriptionSettings } from "@t3tools/contracts";
import { voiceSettingsRequest } from "../../voice/voiceSettingsClient";
import { useSettingsScope } from "./SettingsScopeContext";
import { readEnvironmentScope } from "../../state/session";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function VoiceTranscriptionSettingsPanel() {
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId;
  const [settings, setSettings] = useState<typeof VoiceTranscriptionSettings.Type | null>(null);
  const [provider, setProvider] = useState<"codex-account" | "openai-api">("codex-account");
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("gpt-transcribe");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editable = environmentId && readEnvironmentScope(environmentId, AuthSettingsWriteScope);
  useEffect(() => {
    let current = true;
    setSettings(null);
    setApiKey("");
    setError("");
    if (environmentId)
      void voiceSettingsRequest(environmentId)
        .then((value) => {
          if (!current) return;
          setSettings(value);
          setProvider(value.provider);
          setInstanceId(value.instanceId ?? "");
          setModel(value.model);
        })
        .catch(() => {
          if (current) setError("Could not read voice settings from this environment.");
        });
    return () => {
      current = false;
    };
  }, [environmentId]);
  const save = async (clearKey = false) => {
    if (!environmentId || !editable) return;
    setBusy(true);
    setError("");
    try {
      const value = await voiceSettingsRequest(environmentId, {
        provider,
        instanceId: instanceId || null,
        model,
        ...(clearKey ? { apiKey: null } : apiKey.trim() ? { apiKey } : {}),
      });
      setApiKey("");
      setSettings(value);
    } catch {
      setError(
        "Could not save voice settings. Check this environment's connection and settings permission.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="voice" title="Voice transcription">
      <SettingsRow
        {...searchableSetting("voice-transcription")}
        title="Transcription provider"
        description="Applies to the selected environment. Reviewed recordings stay in their original draft while you change settings."
      >
        <select
          aria-label="Voice transcription provider"
          value={provider}
          disabled={!settings || !editable || busy}
          onChange={(event) => setProvider(event.target.value as "codex-account" | "openai-api")}
        >
          <option value="codex-account">Codex / ChatGPT account</option>
          <option value="openai-api">OpenAI API key</option>
        </select>
      </SettingsRow>
      {provider === "codex-account" ? (
        <SettingsRow
          title="Codex account"
          description="Uses the enabled Codex instance and its existing sign-in. No API key is needed. If authorization is rejected, check Providers settings."
        >
          <select
            aria-label="Transcription Codex account"
            value={instanceId}
            disabled={!settings || !editable || busy}
            onChange={(event) => setInstanceId(event.target.value)}
          >
            <option value="">Automatic</option>
            {settings?.instances.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
                {entry.authenticated ? "" : " (sign-in required)"}
              </option>
            ))}
          </select>
        </SettingsRow>
      ) : (
        <SettingsRow
          title="OpenAI API key"
          description={
            settings?.apiKeySource === "environment"
              ? "Provided by this host's private launch environment. Leave empty to keep it."
              : settings?.apiKeyConfigured
                ? "A key is saved in this environment's private secret store. Leave empty to keep it."
                : "Stored only in this environment's private secret store. API billing applies."
          }
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label="Transcription API key"
            value={apiKey}
            disabled={!editable || busy}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </SettingsRow>
      )}
      <SettingsRow
        title="Transcription model"
        description="Used for OpenAI API and managed Codex account transcription."
      >
        <Input
          aria-label="Transcription model"
          value={model}
          disabled={!editable || busy}
          onChange={(event) => setModel(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow
        title="Provider status"
        description={
          error || settings?.message || "Select a connected environment to read its voice settings."
        }
      >
        {provider === "openai-api" && settings?.apiKeySource === "saved" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={!editable || busy}
            onClick={() => void save(true)}
          >
            Remove saved key
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          disabled={!settings || !editable || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save voice settings"}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
