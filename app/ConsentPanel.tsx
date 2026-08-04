"use client";

import { useId, useState } from "react";
import type { ConsentChoice } from "./auth/client";
import type { PlayerStatsCopy } from "./PlayerStatsPanel";

export type ConsentCopy = Pick<
  PlayerStatsCopy,
  | "consentTitle"
  | "consentIntro"
  | "consentItemRequired"
  | "consentItemAuth"
  | "consentItemProviders"
  | "consentItemAnalytics"
  | "consentItemMarketing"
  | "consentContinueLocal"
  | "consentSignIn"
  | "consentSettings"
  | "consentChangeLater"
>;

export type ConsentPanelProps = {
  copy: ConsentCopy;
  /**
   * "banner" — the fixed first-visit banner rendered by the page shell;
   * "inline" — the re-openable data-settings view inside the profile panel.
   */
  mode: "banner" | "inline";
  currentChoice?: ConsentChoice | null;
  onChoose: (choice: ConsentChoice) => void;
};

export function ConsentPanel({
  copy,
  mode,
  currentChoice = null,
  onChoose,
}: ConsentPanelProps) {
  const headingId = useId();
  const listId = useId();
  const [listOpen, setListOpen] = useState(true);

  return (
    <section
      aria-labelledby={headingId}
      className={
        mode === "banner"
          ? "consent-panel consent-banner"
          : "consent-panel consent-panel-inline"
      }
    >
      <h3 id={headingId}>{copy.consentTitle}</h3>
      <p className="consent-intro">{copy.consentIntro}</p>
      <button
        aria-controls={listId}
        aria-expanded={listOpen}
        className="consent-settings-toggle"
        onClick={() => setListOpen((current) => !current)}
        type="button"
      >
        {copy.consentSettings}
      </button>
      <ul className="consent-list" hidden={!listOpen} id={listId}>
        <li>{copy.consentItemRequired}</li>
        <li>{copy.consentItemAuth}</li>
        <li>{copy.consentItemProviders}</li>
        <li>{copy.consentItemAnalytics}</li>
        <li>{copy.consentItemMarketing}</li>
      </ul>
      <div className="consent-actions">
        <button
          aria-pressed={currentChoice === "account" ? true : undefined}
          className="button primary"
          onClick={() => onChoose("account")}
          type="button"
        >
          {copy.consentSignIn}
        </button>
        <button
          aria-pressed={currentChoice === "local" ? true : undefined}
          className="button secondary"
          onClick={() => onChoose("local")}
          type="button"
        >
          {copy.consentContinueLocal}
        </button>
      </div>
      {mode === "inline" && (
        <p className="consent-note">{copy.consentChangeLater}</p>
      )}
    </section>
  );
}

export default ConsentPanel;
