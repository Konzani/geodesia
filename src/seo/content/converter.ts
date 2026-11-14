import type { ToolPageContent } from './types';

export const converterContent: ToolPageContent = {
  slug: 'land-unit-converter',
  eyebrow: 'Instrument 03 · Units',
  h1: 'One area, every unit a deed or a plan might quote',
  lede:
    'Enter a land area in any unit and read it in all of them at once — metric, imperial, and the Kenyan cadastral units a surveyor still quotes to clients — with exact factors and the definition of the unit you enter shown under the selector.',

  intro: [
    'The converter takes a single land-area magnitude and returns it in every unit the instrument supports: square metres, ares, hectares and square kilometres; square feet, square yards, acres and square miles; and the cadastral and agricultural units still used in East African conveyancing — roods, guntas and decimals. All eleven are displayed together, ordered by magnitude, because a parcel is rarely quoted in one system only: a title may be in hectares, a purchaser may ask in acres, and the field officer may speak in guntas.',
    'Every conversion is one multiplication by a defined factor, not a chain of rounded intermediate steps. The imperial factors follow from exact definitions — 1 foot = 0.3048 m, 1 yard = 0.9144 m, 1 acre = 4840 square yards = 4046.8564224 m² — and the metric ones are exact by construction: 1 are = 100 m², 1 hectare = 10 000 m², 1 square kilometre = 1 000 000 m². The rood, the gunta and the decimal are exact fractions of an acre — one quarter, one fortieth and one hundredth — so they inherit the acre’s exactness. The only rounding in the instrument is the rounding used to display a value; the arithmetic keeps double precision, and the CSV carries the computed figures.',
    'These units persist because land is transacted in the vocabulary written on the deed and spoken in the market. A gunta is how a small agricultural plot is described; a rood survives on older titles and estate schedules; a decimal is how plot sizes are quoted in ordinary land transactions. Converting them into hectares is a registry chore rather than a decision, which is precisely the work a deterministic converter should do — without a mental chain of fractions, and with the unit definition stated beside the number so the figure can be defended when it is read back to you.',
  ],

  features: [
    {
      title: 'Every unit at once, grouped',
      text: 'The eleven supported units are grouped as metric, imperial and cadastral/agricultural and ordered by magnitude within each table. One value in one unit fills every row, so the size of a hectare against an acre, or a decimal against a square metre, is visible without a second calculation.',
    },
    {
      title: 'Exact factors, declared precision',
      text: 'Each unit is stored as a single factor to square metres, taken from its exact definition: 1 acre = 4046.8564224 m², 1 rood = 1011.7141056 m², 1 gunta = 101.17141056 m², 1 decimal = 40.468564224 m², 1 ft² = 0.09290304 m². A conversion multiplies into square metres and divides out again, so no rounded intermediate value is ever carried from one unit to another.',
    },
    {
      title: 'Width × length dimension helper',
      text: 'When the source is a dimensioned plan rather than a stated area, enter width and length in metres or feet and the helper returns square metres after reconciling both dimensions to metres at the exact 0.3048 m foot. It treats the shape as a rectangle, which is the right assumption for a building footprint or a regular plot and must be stated when the parcel is not one.',
    },
    {
      title: 'Copy a single row',
      text: 'A copy button on each row puts that value on the clipboard at the precision shown on screen, so a figure can go into a message or a schedule without being retyped. The copied text and the visible row come from the same computed magnitude.',
    },
    {
      title: 'CSV export of the whole table',
      text: 'The full ledger exports as a CSV with the input line, a note that the conversion is exact, and one row per unit carrying its identifier, name, symbol, value and group. It opens in a spreadsheet without an import wizard, because it is written with a UTF-8 byte-order mark and RFC 4180 quoting.',
    },
  ],

  workflow: [
    {
      title: 'Enter the magnitude you actually have',
      text: 'Type the area and choose its unit from the grouped selector, starting from square metres if you are unsure. A comma may be used as the decimal separator instead of a point, so a figure copied from another locale does not need reformatting first.',
    },
    {
      title: 'Read the group that will be quoted',
      text: 'The metric rows answer the registry question, the imperial rows the archival and engineering one, and the cadastral rows the question asked at the counter. Check the unit definition shown under the selector before quoting a cadastral figure, because customary usage is the one place where local practice can differ from the definition.',
    },
    {
      title: 'Convert dimensions when that is the source',
      text: 'If you have a plan, measure width and length in the same unit, enter both in the dimension helper and apply its square-metre result back into the conversion. Do not apply it to a quadrilateral that is not a rectangle; that is a coordinate question for the polygon area instrument rather than a multiplication.',
    },
    {
      title: 'Copy or export, and record the basis',
      text: 'Copy the row you need, or export the ledger and file it with the figure. The CSV header records the input magnitude and unit, so a conversion can be reconstructed later from the file alone rather than from memory.',
    },
  ],

  formulas: [
    {
      name: 'Area conversion through square metres',
      body: 'A_m² = v × f_from   ·   v_to = A_m² / f_to',
      note: 'Every supported unit is defined by one factor f, the number of square metres in one unit, so a conversion is a single multiplication into square metres and a single division into the target unit; a round trip returns the input magnitude to floating-point precision. The factors in use are: m² 1; are 100; hectare 10 000; km² 1 000 000; ft² 0.09290304; yd² 0.83612736; acre 4046.8564224; mi² 2 589 988.110336; rood 1011.7141056; gunta 101.17141056; decimal 40.468564224. Each is exact given its defining relation — 1 ft = 0.3048 m, 1 yd = 0.9144 m, 1 acre = 4840 yd², 1 rood = ¼ acre, 1 gunta = 1/40 acre, 1 decimal = 1/100 acre.',
    },
    {
      name: 'Dimensions to area',
      body: 'A = w × l   ·   A_m² = (w × 0.3048) × (l × 0.3048) for feet',
      note: 'The helper multiplies width by length after reconciling both to metres using the exact 0.3048 m foot. It is a rectangle calculation: a 25 m × 40 m plot is 1 000 m² exactly, while a quadrilateral whose opposite sides are not parallel is a polygon question and belongs in the coordinate instrument, where every corner is used instead of two dimensions.',
    },
  ],

  specs: [
    {
      label: 'Units',
      value:
        'm² · are · hectare · km² · ft² · yd² · acre · mi² · rood · gunta · decimal (ids: m2, ares, ha, km2, ft2, yd2, acres, mi2, roods, guntas, decimals)',
    },
    {
      label: 'Exact factors',
      value:
        '1 acre = 4046.8564224 m² · 1 rood = 1011.7141056 m² · 1 gunta = 101.17141056 m² · 1 decimal = 40.468564224 m² · 1 ft² = 0.09290304 m² · 1 yd² = 0.83612736 m²',
    },
    {
      label: 'Ordering and grouping',
      value: 'Metric · imperial · cadastral/agricultural; each group ordered by magnitude',
    },
    {
      label: 'Rounding',
      value:
        'Display decimals step down as magnitude grows (none at 10⁶ and above, six below 0.01); arithmetic at double precision',
    },
    {
      label: 'Export',
      value: 'CSV · UTF-8 with BOM · RFC 4180 quoting · input line plus one row per unit',
    },
    { label: 'Execution', value: 'Client-side · no server call · no upload · no account' },
  ],

  faqs: [
    {
      q: 'How many guntas are in an acre?',
      a: 'Forty, exactly, because the gunta is defined as one fortieth of an acre: 1 gunta = 101.17141056 m² and 40 guntas = 4046.8564224 m². The same acre also divides into four roods or one hundred decimals, and those three units are therefore mutually consistent — 40 guntas, 4 roods and 100 decimals all equal one acre.',
    },
    {
      q: 'How does a rood relate to an acre?',
      a: 'A rood is a quarter of an acre — 1011.7141056 m² — so four roods make the acre. It is the older English quarter-acre unit, and it survives on older deeds and estate schedules where the acre is too large a unit for the plot being sold. In the converter it is always shown beside the acre, so a title stated in roods can be checked against a modern area without a chain of fractions.',
    },
    {
      q: 'Is a decimal always one hundredth of an acre?',
      a: 'In the usage this instrument documents, yes: the decimal is defined as 1/100 acre = 40.468564224 m², and the converter uses that definition throughout. It is a customary unit rather than an SI unit, and a deed or a valuer may quote a rounded decimal count, so check the stated area against the title figure rather than assuming the unit name alone settles the question.',
    },
    {
      q: 'Why does a hectare never round to a clean number of acres?',
      a: 'Because the ratio between the units is not a terminating decimal: 1 hectare = 10 000 m² and 1 acre = 4046.8564224 m², so 1 hectare = 2.471053814… acres. That is why a round hectare converts to an untidy acre figure, and a round acre converts to 0.4047 ha. The converter shows the exact quotient and rounds only the display, so the digits after a round figure are real rather than a conversion error.',
    },
    {
      q: 'What is the difference between an are and an acre?',
      a: 'An are is 100 m² — a square ten metres by ten metres — and is purely metric: a hectare is one hundred ares. An acre is 4046.8564224 m², about 40.47 ares, and belongs to the imperial system. The names are similar but the units are not: a hectare is 100 ares and 2.4711 acres, so the two systems meet only through the square metre.',
    },
    {
      q: 'Can I convert the square footage of a building plan?',
      a: 'Yes. Enter the plan figure in square feet as the input unit, or measure the two dimensions in the dimension helper with feet selected, and read the metric area beside it. A building plan is drawn to a stated scale and its room areas are often rounded independently, so treat the plan figure as a rounded area and quote the converted value only to the precision the plan supports.',
    },
  ],

  closing:
    'A conversion is a small calculation, but it is one that gets copied into contracts, valuations and field notes, where a misplaced factor is expensive. The converter therefore states the definition of every unit, keeps the arithmetic exact and labels the cadastral units as the customary units they are. Nothing is sent to a server, the CSV records the input and the result together, and any figure produced here can be checked by hand against the definitions above.',
};
