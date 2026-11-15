/**
 * The wardrobe's Role tab: what an agent launched as this character runs with — an agent
 * definition (`--agent`), a model and an effort. Edits go through the cast draft like any
 * other (undoable, kept only on Save); all defaults = no `launch` on the profile.
 */

import { useState } from 'react';

import { type CharacterLaunch, LAUNCH_EFFORTS } from '../../../../core/src/characterProfiles.js';
import type { LaunchRole } from '../../../../core/src/messages.js';
import { useT } from '../../i18n/index.js';
import {
  isValidLaunchValue,
  LAUNCH_MODEL_PRESETS,
  type LaunchField,
  offeredRoles,
  pathBasename,
  roleModel,
  setLaunchField,
} from '../launch.js';
import { useLaunchRoles } from '../launchRoles.js';
import { useStudio } from './studio.js';

interface Choice {
  key: string;
  label: string;
  title?: string;
  pressed: boolean;
  onClick: () => void;
}

function Chips({ label, choices }: { label: string; choices: Choice[] }) {
  return (
    <div className="chv-chips" role="group" aria-label={label}>
      {choices.map((c) => (
        <button
          key={c.key}
          type="button"
          className="chv-chip"
          aria-pressed={c.pressed}
          title={c.title}
          onClick={c.onClick}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A typed-in value for one launch field. Applied as it is typed while valid (empty =
 * the default); an invalid one is shown with a hint but never reaches the profile. What
 * was typed is kept only while the profile still holds the value it was typed over, so
 * an undo (or another character) shows the profile's own value again.
 */
function CustomField({
  field,
  value,
  placeholder,
  invalidHint,
  label,
}: {
  field: LaunchField;
  value: string | undefined;
  placeholder: string;
  invalidHint: string;
  label: string;
}) {
  const { edit } = useStudio();
  const [typed, setTyped] = useState<{ text: string; over: string | undefined } | null>(null);
  const text = typed && typed.over === value ? typed.text : (value ?? '');
  const valid = !text.trim() || isValidLaunchValue(field, text);
  return (
    <div className="chv-role-custom">
      <input
        value={text}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={!valid}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => {
          const next = e.target.value;
          const trimmed = next.trim();
          const ok = !trimmed || isValidLaunchValue(field, trimmed);
          const applied = ok ? trimmed || undefined : value;
          if (ok && applied !== value) edit((p) => void setLaunchField(p, field, trimmed || null));
          setTyped({ text: next, over: applied });
        }}
      />
      {!valid && <p className="chv-note chv-role-invalid">{invalidHint}</p>}
    </div>
  );
}

function roleTitle(role: LaunchRole): string | undefined {
  const parts = [role.description, role.directory].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

function AgentChoice({ launch }: { launch: CharacterLaunch | undefined }) {
  const t = useT();
  const { edit } = useStudio();
  const loaded = useLaunchRoles();
  const roles = offeredRoles(loaded ?? []);
  const agent = launch?.agent;
  const known = !!agent && roles.some((r) => r.name === agent);
  const [customOpen, setCustomOpen] = useState(false);
  const custom = customOpen || (!!agent && !known);
  const set = (value: string | null) => {
    setCustomOpen(false);
    if ((value ?? undefined) !== agent) edit((p) => void setLaunchField(p, 'agent', value));
  };
  // a name defined in several places is pressed once (its first, the one whose model counts)
  const firstOfAgent = roles.findIndex((r) => r.name === agent);
  return (
    <div className="chv-colors">
      <h2>{t('characters.roleAgent')}</h2>
      <p className="chv-note">{t('characters.roleAgentHint')}</p>
      <div className="chv-roles" role="group" aria-label={t('characters.roleAgent')}>
        <button
          type="button"
          className="chv-role"
          aria-pressed={!agent && !custom}
          onClick={() => set(null)}
        >
          <b>{t('characters.roleNone')}</b>
        </button>
        {roles.map((role, i) => (
          <button
            key={`${role.scope}:${role.directory ?? ''}:${role.name}`}
            type="button"
            className="chv-role"
            aria-pressed={!custom && i === firstOfAgent}
            title={roleTitle(role)}
            onClick={() => set(role.name)}
          >
            <b>
              {role.name}
              <span className="chv-role-scope">
                {role.scope === 'user' || !role.directory
                  ? t('characters.roleUser')
                  : pathBasename(role.directory)}
              </span>
            </b>
            {role.description && <span className="chv-role-desc">{role.description}</span>}
          </button>
        ))}
        <button
          type="button"
          className="chv-role"
          aria-pressed={custom}
          onClick={() => setCustomOpen(true)}
        >
          <b>{t('characters.roleCustom')}</b>
        </button>
      </div>
      {loaded === null && <p className="chv-note">{t('characters.roleLoading')}</p>}
      {loaded !== null && roles.length === 0 && (
        <p className="chv-note">{t('characters.roleNoneFound')}</p>
      )}
      {custom && (
        <CustomField
          field="agent"
          value={agent}
          placeholder={t('characters.roleCustomPlaceholder')}
          invalidHint={t('characters.roleAgentInvalid')}
          label={`${t('characters.roleAgent')}: ${t('characters.roleCustom')}`}
        />
      )}
      {loaded !== null && !!agent && !known && (
        <p className="chv-note chv-role-invalid">{t('characters.roleNotFound')}</p>
      )}
    </div>
  );
}

function ModelChoice({ launch }: { launch: CharacterLaunch | undefined }) {
  const t = useT();
  const { edit } = useStudio();
  const roles = useLaunchRoles();
  const model = launch?.model;
  const preset = !!model && (LAUNCH_MODEL_PRESETS as readonly string[]).includes(model);
  const [customOpen, setCustomOpen] = useState(false);
  const custom = customOpen || (!!model && !preset);
  const set = (value: string | null) => {
    setCustomOpen(false);
    if ((value ?? undefined) !== model) edit((p) => void setLaunchField(p, 'model', value));
  };
  const fromRole = roleModel(roles ?? [], launch?.agent);
  const choices: Choice[] = [
    {
      key: '_default',
      label: t('characters.roleDefault'),
      title: t('characters.roleModelDefaultHint'),
      pressed: !model && !custom,
      onClick: () => set(null),
    },
    ...LAUNCH_MODEL_PRESETS.map((m) => ({
      key: m,
      label: m,
      pressed: !custom && model === m,
      onClick: () => set(m),
    })),
    {
      key: '_custom',
      label: t('characters.roleCustom'),
      pressed: custom,
      onClick: () => setCustomOpen(true),
    },
  ];
  return (
    <div className="chv-colors">
      <h2>{t('characters.roleModel')}</h2>
      <Chips label={t('characters.roleModel')} choices={choices} />
      {custom && (
        <CustomField
          field="model"
          value={model}
          placeholder={t('characters.roleModelPlaceholder')}
          invalidHint={t('characters.roleModelInvalid')}
          label={`${t('characters.roleModel')}: ${t('characters.roleCustom')}`}
        />
      )}
      {!model && !custom && fromRole && (
        <p className="chv-note">{t('characters.roleModelFromRole', { model: fromRole })}</p>
      )}
    </div>
  );
}

function EffortChoice({ launch }: { launch: CharacterLaunch | undefined }) {
  const t = useT();
  const { edit } = useStudio();
  const effort = launch?.effort;
  const set = (value: string | null) => {
    if ((value ?? undefined) !== effort) edit((p) => void setLaunchField(p, 'effort', value));
  };
  const choices: Choice[] = [
    {
      key: '_default',
      label: t('characters.roleDefault'),
      title: t('characters.roleEffortDefaultHint'),
      pressed: !effort,
      onClick: () => set(null),
    },
    ...LAUNCH_EFFORTS.map((e) => ({
      key: e,
      label: e,
      pressed: effort === e,
      onClick: () => set(e),
    })),
  ];
  return (
    <div className="chv-colors">
      <h2>{t('characters.roleEffort')}</h2>
      <Chips label={t('characters.roleEffort')} choices={choices} />
    </div>
  );
}

/** The Role tab's body. Keyed by the character by its caller, so typed text never carries over. */
export function RolePanel() {
  const t = useT();
  const { profile } = useStudio();
  const launch = profile.launch;
  return (
    <div className="chv-slot-body chv-role-panel">
      <p className="chv-note">{t('characters.roleNote')}</p>
      <AgentChoice launch={launch} />
      <ModelChoice launch={launch} />
      <EffortChoice launch={launch} />
    </div>
  );
}
