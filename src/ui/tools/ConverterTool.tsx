/**
 * GEODESIA — Land Area & Unit Converter instrument.
 *
 * Simplified, plain-language flow in three steps:
 *   1 Type the area
 *   2 Pick its unit
 *   3 Read it in other units
 *
 * One value + one unit converted into every supported land unit at once,
 * grouped metric / imperial / cadastral-agricultural and ordered by magnitude.
 * Per-row copy buttons, a width × length helper (inside Advanced options) and
 * CSV export. Kenyan cadastral units (roods, guntas) are preserved as
 * first-class units. No map is needed for this instrument.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AreaUnitDef, ConversionRow, UnitGroup } from '../../math/types';
import { AREA_UNITS, areaFromDimensions, convertAll, convertArea, fmtNumber } from '../../math';
import { exportCSV, exportFilename } from '../../exports';
import { EmptyState, Field, Notice, Panel, Readout, Segmented, Toolbar } from '../components/ui';
import { IconCheck, IconCopy, IconDownload, IconRuler } from './icons';
import { copyToClipboard, errorMessage, magnitudeDecimals } from './utils';

interface ConversionSection {
  key: string;
  title: string;
  groups: UnitGroup[];
  rows: ConversionRow[];
}

const sections: ReadonlyArray<{ key: string; title: string; groups: UnitGroup[] }> = [
  { key: 'metric', title: 'Metric', groups: ['metric'] },
  { key: 'imperial', title: 'Imperial', groups: ['imperial'] },
  { key: 'cadastral', title: 'Cadastral & agricultural', groups: ['cadastral', 'agricultural'] },
];

const dimensionUnits: ReadonlyArray<{ value: 'm' | 'ft'; label: string }> = [
  { value: 'm', label: 'Metres' },
  { value: 'ft', label: 'Feet' },
];

/** A full-size football pitch: 105 m × 68 m = 7,140 m² (a familiar yardstick). */
const FOOTBALL_PITCH_M2 = 105 * 68;

const ACRE_M2 = 4046.8564224;

function findUnit(predicate: (unit: AreaUnitDef) => boolean): AreaUnitDef | undefined {
  return AREA_UNITS.find(predicate);
}

function preferredSquareMetre(): AreaUnitDef | undefined {
  return (
    findUnit((unit) => unit.id === 'm2') ??
    findUnit((unit) => unit.symbol.replace(/\s/g, '') === 'm²') ??
    findUnit((unit) => unit.symbol.replace(/\s/g, '') === 'm2') ??
    AREA_UNITS[0]
  );
}

/** Plain-language headline shown above the full unit tables. */
function converterSentence(value: number, symbol: string, m2: number): string {
  const hectares = m2 / 10000;
  const acres = m2 / ACRE_M2;
  const pitches = m2 / FOOTBALL_PITCH_M2;
  const yardstick =
    pitches >= 1
      ? `about ${fmtNumber(pitches, 1)} football pitches`
      : pitches >= 0.02
        ? `about ${fmtNumber(pitches * 100, 0)}% of a football pitch`
        : 'smaller than a football pitch';
  return `${fmtNumber(value, magnitudeDecimals(value))} ${symbol} is ${fmtNumber(m2, 2)} m² — that is ${fmtNumber(hectares, 4)} ha or ${fmtNumber(acres, 4)} acres, ${yardstick}.`;
}

export default function ConverterTool() {
  const defaultFrom = useMemo(() => preferredSquareMetre()?.id ?? '', []);
  const squareMetreUnit = useMemo(() => preferredSquareMetre() ?? null, []);
  const hectareUnit = useMemo(() => findUnit((unit) => unit.symbol === 'ha') ?? null, []);
  const [fromUnit, setFromUnit] = useState('');
  const [valueText, setValueText] = useState('1');
  const [copiedUnit, setCopiedUnit] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);

  const [dimWidth, setDimWidth] = useState('');
  const [dimLength, setDimLength] = useState('');
  const [dimUnit, setDimUnit] = useState<'m' | 'ft'>('m');
  const [dimResult, setDimResult] = useState<number | null>(null);
  const [dimError, setDimError] = useState<string | null>(null);

  const valueId = useId();
  const unitId = useId();
  const widthId = useId();
  const lengthId = useId();
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const effectiveFrom = fromUnit || defaultFrom;
  const fromDefinition = useMemo(
    () => AREA_UNITS.find((unit) => unit.id === effectiveFrom),
    [effectiveFrom],
  );

  const numericValue = useMemo<number | null>(() => {
    const trimmed = valueText.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }, [valueText]);

  const valueError =
    valueText.trim().length === 0
      ? null
      : numericValue === null
        ? 'Enter a numeric area value.'
        : numericValue < 0
          ? 'Areas cannot be negative.'
          : null;

  const conversions = useMemo<ConversionRow[]>(() => {
    if (numericValue === null || numericValue < 0 || !effectiveFrom) return [];
    try {
      return convertAll(numericValue, effectiveFrom);
    } catch {
      return [];
    }
  }, [numericValue, effectiveFrom]);

  const conversionSections = useMemo<ConversionSection[]>(
    () =>
      sections.map((section) => ({
        ...section,
        rows: conversions.filter((row) => section.groups.includes(row.group)),
      })),
    [conversions],
  );

  const squareMetres = useMemo<number | null>(() => {
    if (numericValue === null || numericValue < 0 || !fromDefinition) return null;
    return numericValue * fromDefinition.factor;
  }, [numericValue, fromDefinition]);

  const announce = (message: string) => {
    setStatusMessage(message);
  };

  const copyRow = async (row: ConversionRow) => {
    const text = fmtNumber(row.value, magnitudeDecimals(row.value));
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedUnit(row.unit);
      announce(`Copied ${row.label} value ${text}.`);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedUnit(null), 1600);
    } else {
      setCopiedUnit(null);
      announce('Copy failed — select the value and copy manually.');
    }
  };

  const computeDimensions = () => {
    const width = Number(dimWidth.trim().replace(',', '.'));
    const length = Number(dimLength.trim().replace(',', '.'));
    if (!Number.isFinite(width) || !Number.isFinite(length) || width <= 0 || length <= 0) {
      setDimError('Enter a positive width and length.');
      setDimResult(null);
      return;
    }
    try {
      setDimResult(areaFromDimensions(width, length, dimUnit));
      setDimError(null);
    } catch (error) {
      setDimError(errorMessage(error));
      setDimResult(null);
    }
  };

  const useDimensionResult = () => {
    if (dimResult === null) return;
    const squareMetre = squareMetreUnit ?? preferredSquareMetre();
    if (!squareMetre) return;
    setValueText(fmtNumber(dimResult, 6));
    setFromUnit(squareMetre.id);
    announce(`Applied ${fmtNumber(dimResult, 2)} m² from the dimension helper.`);
  };

  const exportTable = () => {
    setExportError(null);
    try {
      const columns = [
        { key: 'unit', label: 'Unit id' },
        { key: 'label', label: 'Unit' },
        { key: 'symbol', label: 'Symbol' },
        { key: 'value', label: 'Value' },
        { key: 'group', label: 'Group' },
      ];
      exportCSV(
        exportFilename('land-unit-converter', 'csv'),
        columns,
        conversions.map((row) => ({
          unit: row.unit,
          label: row.label,
          symbol: row.symbol,
          value: row.value,
          group: row.group,
        })),
        [
          'Geodesia — Land Area & Unit Converter',
          `Input: ${fmtNumber(numericValue ?? 0, 6)} ${fromDefinition?.symbol ?? ''}`,
          'All values are exact conversions from the input magnitude.',
        ],
      );
      announce('Exported converter CSV.');
    } catch (error) {
      setExportError(errorMessage(error));
    }
  };

  const hectares = squareMetres === null ? null : squareMetres / 10000;
  const acres = squareMetres === null ? null : squareMetres / ACRE_M2;
  const roods = squareMetres === null ? null : squareMetres / (ACRE_M2 / 4);
  const pitches = squareMetres === null ? null : squareMetres / FOOTBALL_PITCH_M2;

  return (
    <div className="tool-page">
      <p className="sr-only" aria-live="polite">
        {statusMessage}
      </p>

      <div className="tool-stage tool-stage--auto">
        {/* ------------------------------------------------------- controls */}
        <div className="tool-stage__side">
          <section className="step-card" aria-labelledby="converter-step-1">
            <div className="step-card__head">
              <span className="step-card__num" aria-hidden="true">
                1
              </span>
              <h3 className="step-card__title" id="converter-step-1">
                Type the area
              </h3>
            </div>
            <div className="step-card__body">
              <Field label="Value" htmlFor={valueId} hint="Any positive number — decimals and commas both work.">
                <input
                  id={valueId}
                  className="input input--lg"
                  type="text"
                  inputMode="decimal"
                  value={valueText}
                  aria-invalid={valueError !== null || undefined}
                  aria-describedby={valueError ? `${valueId}-error` : undefined}
                  onChange={(event) => setValueText(event.target.value)}
                />
              </Field>
              {valueError ? <Notice tone="err">{valueError}</Notice> : null}
            </div>
          </section>

          <section className="step-card" aria-labelledby="converter-step-2">
            <div className="step-card__head">
              <span className="step-card__num" aria-hidden="true">
                2
              </span>
              <h3 className="step-card__title" id="converter-step-2">
                Pick its unit
              </h3>
            </div>
            <div className="step-card__body">
              <Field label="From unit" htmlFor={unitId} hint={fromDefinition?.note}>
                <select
                  id={unitId}
                  className="select"
                  value={effectiveFrom}
                  onChange={(event) => setFromUnit(event.target.value)}
                >
                  {sections.map((section) => (
                    <optgroup key={section.key} label={section.title}>
                      {AREA_UNITS.filter((unit) => section.groups.includes(unit.group)).map((unit) => (
                        <option key={unit.id} value={unit.id}>
                          {unit.label} ({unit.symbol})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              {fromDefinition ? null : <Notice tone="warn">No unit definitions are available.</Notice>}
            </div>
          </section>

          <details className="advanced">
            <summary>Advanced options</summary>
            <div className="advanced__body">
              <div className="stack stack--sm">
                <span className="field__label">
                  <span>Dimension helper</span>
                  <span className="field__unit">width × length</span>
                </span>
                <Segmented
                  options={dimensionUnits}
                  value={dimUnit}
                  onChange={setDimUnit}
                  label="Dimension unit"
                />
                <div className="field-row">
                  <Field label="Width" htmlFor={widthId} unit={dimUnit}>
                    <input
                      id={widthId}
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={dimWidth}
                      placeholder="25"
                      onChange={(event) => setDimWidth(event.target.value)}
                    />
                  </Field>
                  <Field label="Length" htmlFor={lengthId} unit={dimUnit}>
                    <input
                      id={lengthId}
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={dimLength}
                      placeholder="40"
                      onChange={(event) => setDimLength(event.target.value)}
                    />
                  </Field>
                </div>
                {dimError ? <Notice tone="err">{dimError}</Notice> : null}
                {dimResult !== null ? (
                  <Readout
                    label="Computed area"
                    value={fmtNumber(dimResult, 2)}
                    unit="m²"
                    delta={
                      hectareUnit
                        ? `= ${fmtNumber(
                            convertArea(dimResult, squareMetreUnit?.id ?? 'm2', hectareUnit.id),
                            4,
                          )} ha`
                        : undefined
                    }
                  />
                ) : null}
                <div className="btn-row">
                  <button type="button" className="btn btn--sm" onClick={computeDimensions}>
                    <IconRuler size={14} /> Compute area
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--quiet"
                    onClick={useDimensionResult}
                    disabled={dimResult === null}
                  >
                    Use as value
                  </button>
                </div>
              </div>
              <p className="tool-hint">
                Roods and guntas are commonly used in Kenyan cadastral and agricultural work; they are
                presented as exact conversions of the computed magnitude, not rounded local variants.
              </p>
            </div>
          </details>
        </div>

        {/* ---------------------------------------------------------- results */}
        <div className="tool-stage__hero">
          <Panel
            title="3 · Read it in other units"
            meta={
              fromDefinition && numericValue !== null
                ? `${fmtNumber(numericValue, magnitudeDecimals(numericValue))} ${fromDefinition.symbol} · ${fmtNumber(conversions.length, 0)} units`
                : 'Awaiting a value'
            }
            actions={
              <Toolbar label="Converter actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={exportTable}
                  disabled={conversions.length === 0}
                >
                  <IconDownload size={14} /> CSV
                </button>
              </Toolbar>
            }
            footer={
              <span className="panel__meta">
                Every unit is an exact conversion from the input magnitude · no rounding in the
                calculation, only for display
              </span>
            }
          >
            {conversions.length === 0 || squareMetres === null || fromDefinition === undefined ? (
              <EmptyState icon={<IconRuler size={22} />} title="Enter an area to convert">
                Type a positive area and choose its unit. Every supported land unit updates at once,
                grouped metric / imperial / cadastral-agricultural.
              </EmptyState>
            ) : (
              <>
                <div className="result-line">
                  <p className="result-line__text">
                    {converterSentence(numericValue ?? 0, fromDefinition.symbol, squareMetres)}
                  </p>
                  <div className="unit-chips">
                    <span className="unit-chip unit-chip--accent">
                      <strong>{fmtNumber(squareMetres, 2)} m²</strong> square metres
                    </span>
                    {hectares !== null ? (
                      <span className="unit-chip">
                        <strong>{fmtNumber(hectares, 4)} ha</strong> hectares
                      </span>
                    ) : null}
                    {acres !== null ? (
                      <span className="unit-chip">
                        <strong>{fmtNumber(acres, 2)} acres</strong>
                      </span>
                    ) : null}
                    {roods !== null ? (
                      <span className="unit-chip">
                        <strong>{fmtNumber(roods, 1)} roods</strong> on older deeds
                      </span>
                    ) : null}
                    {pitches !== null ? (
                      <span className="unit-chip">
                        about <strong>{fmtNumber(pitches, 2)}</strong> football pitches
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="converter">
                  {conversionSections.map((section) =>
                    section.rows.length > 0 ? (
                      <section className="converter__section" key={section.key}>
                        <h3 className="converter__heading">
                          {section.title}
                          <span className="converter__count">{fmtNumber(section.rows.length, 0)}</span>
                        </h3>
                        <div className="table-wrap converter__table-wrap">
                          <table className="data-table converter-table">
                            <caption className="sr-only">{section.title} land area conversions</caption>
                            <thead>
                              <tr>
                                <th scope="col" className="is-left">
                                  Unit
                                </th>
                                <th scope="col">Value</th>
                                <th scope="col">
                                  <span className="sr-only">Copy value</span>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {section.rows.map((row) => (
                                <tr key={row.unit}>
                                  <td className="is-left">
                                    <span className="converter-unit__label">{row.label}</span>
                                    <span className="converter-unit__symbol">{row.symbol}</span>
                                  </td>
                                  <td>{fmtNumber(row.value, magnitudeDecimals(row.value))}</td>
                                  <td className="converter-table__copy">
                                    <button
                                      type="button"
                                      className="icon-btn icon-btn--xs"
                                      aria-label={`Copy ${row.label} value`}
                                      title={`Copy ${row.label}`}
                                      onClick={() => void copyRow(row)}
                                    >
                                      {copiedUnit === row.unit ? (
                                        <IconCheck size={13} />
                                      ) : (
                                        <IconCopy size={13} />
                                      )}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    ) : null,
                  )}
                </div>
              </>
            )}
            {exportError ? <Notice tone="err">{exportError}</Notice> : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
