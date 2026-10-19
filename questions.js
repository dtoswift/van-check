/*
 * Gaia Monthly Vehicle Checklist — question template
 *
 * Replicates "Gaia_Monthly_Vehicle_Check_Form.pdf" item for item, in the same
 * order and wording. THIS IS THE ONLY FILE TO EDIT WHEN THE CHECKLIST CHANGES.
 *
 * Question fields
 *   id         unique, stable key. Don't reuse an id for a different question.
 *   text       the item exactly as worded on the paper form
 *   type       'satisfactory'  √ satisfactory / X defective
 *              'yesnona'       Yes / No / N/A
 *              'yesno'         Yes / No
 *              'vehicle'       drop-down of the vans in `vehicles` (registration)
 *              'text'          single line of text
 *              'textarea'      several lines of text
 *              'number'        a number (optional `unit`)
 *              'date'          a date
 *   required   true = must be answered before the PDF can be made
 *   comments   true = item has an optional Comments box (as on the paper form)
 *   flagIf     answer(s) the PDF highlights in red and lists under "Needs attention"
 *   upper      true = text is stored in capitals (registration numbers)
 *
 * Sections: { title, legend, questions[] }. `legend` is the key printed in the
 * paper form's column header, one entry per line, shown above that section's items.
 */

window.VAN_CHECK_TEMPLATE = {
  title: 'MONTHLY VEHICLE CHECKLIST',
  version: 'Gaia Monthly Vehicle Check Form',
  logo: 'logo.jpg', // printed at the top of the PDF; remove to omit
  minPhotos: 1,
  maxPhotos: 12,
  // Restrict the manager's email to these domains, e.g. ['yourcompany.co.uk'].
  // Leave empty to allow any address.
  managerEmailDomains: [],
  photoHint: 'Add clear photos of the outside of the van from each side, plus anything that’s damaged or defective.',

  // The fleet, shown as a drop-down for "Vehicle Registration no". Choosing a
  // van fills in "Vehicle make/type" automatically. One line per van:
  //   { reg: 'AB12 CDE', make: 'Ford Transit Custom' },
  // The drop-down also has "My van isn't on the list" for hire or new vans.
  // If this list is empty, both fields are plain typing boxes instead.
  vehicles: [
    { reg: 'DS24 EFN', make: 'Hyundai Kona' },
    { reg: 'AX24 EXA', make: 'BMW ix2' },
    { reg: 'CJ24LKZ', make: 'Citroen Belingo' },
    { reg: 'CK24 VTA', make: 'Citroen Berlingo' },
    { reg: 'LB25 UCP', make: 'Citroen Berlingo' },
    { reg: 'LB68 UAG', make: 'Citroen Berlingo' },
    { reg: 'ME73 VXN', make: 'Citroen Dispatch' },
    { reg: 'DE24 JDO', make: 'Cupra Formenta' },
    { reg: 'SH26 AOE', make: 'Kia EV5' },
    { reg: 'BP23 XVA', make: 'Nissan Primastar' },
    { reg: 'VK26 NWJ', make: 'Peugeot Partner' },
    { reg: 'VE25 RLO', make: 'Peugeot Partner' },
    { reg: 'VE25 SSX', make: 'Peugeot Partner' },
    { reg: 'OV74 MFX', make: 'Polestar 2 Fastback' },
    { reg: 'OW74 UOG', make: 'Polestar 4 Estate' },
    { reg: 'MC74 KYA', make: 'Renault Kango' },
    { reg: 'EN75 BKK', make: 'Skoda Enyaq' },
    { reg: 'DY76 0BM', make: 'Vauxhall Vivaro' },
    { reg: 'BK25 AKJ', make: 'VW ID3' },
    { reg: 'MH25 AXT', make: 'VW Tiguan' },  
  ],

  // Header lines of the paper form, in order. Driver and Date are the fixed
  // identity fields and are labelled by `labels` below.
  headerFields: [
    { id: 'vehicle-reg', text: 'Vehicle Registration no', type: 'vehicle', required: true },
    { id: 'mileage', text: 'Mileage reading', type: 'number', required: true },
    { id: 'make-type', text: 'Vehicle make/type', type: 'text', required: true },
  ],
  labels: {
    driver: 'Driver',
    date: 'Date',
  },

  sections: [
    {
      title: 'EXTERNAL VEHICLE CONDITION',
      legend: ['√ = satisfactory', 'X = defective'],
      questions: [
        { id: 'ext-bodywork', text: 'Condition of vehicle bodywork, windscreen, windows, lights', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'ext-wiper-blades', text: 'Condition of windscreen wiper blades', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'ext-cleanness', text: 'Cleanness of Vehicle (inc windscreen, windows, mirrors, lights, number plate)', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'ext-tyres', text: 'Condition of tyres, tyre pressure, tyre wear', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
      ],
    },
    {
      title: 'FLUIDS',
      legend: ['√ = satisfactory', 'X = defective'],
      questions: [
        { id: 'fl-engine-oil', text: 'Engine oil level', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'fl-washer', text: 'Windscreen wash level', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'fl-leaks', text: 'Oil or waste leaks', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
      ],
    },
    {
      title: 'VEHICLE INTERIOR AND EQUIPMENT',
      legend: ['√ = satisfactory', 'X = defective'],
      questions: [
        { id: 'int-seat-belts', text: 'Condition & function of seat belts', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'int-head-restraint', text: 'Head restraint adjustment', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'int-clean-front', text: 'Cleanness of Vehicle Front', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'int-clean-back', text: 'Cleanness of Vehicle Back', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'int-first-aid', text: 'First aid kit - fully stocked and in date', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'int-fire-ext', text: 'Fire extinguisher – Still in date', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
      ],
    },
    {
      title: 'FUNCTION CHECKS',
      legend: ['√ = satisfactory', 'X = defective'],
      questions: [
        { id: 'fn-warning-lights', text: 'Warning lights', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'fn-all-lights', text: 'All lights', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'fn-horn', text: 'Horn', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'fn-washers-wipers', text: 'Washers & wipers', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'fn-brake', text: 'Brake', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
        { id: 'fn-tyres', text: 'Tyres', type: 'satisfactory', required: true, comments: true, flagIf: 'Defective' },
      ],
    },
    {
      title: 'VEHICLE INFORMATION',
      legend: ['Y = Yes  N = No', 'N/A = not applicable'],
      questions: [
        { id: 'info-service-due', text: 'Is a Service Due', type: 'yesnona', required: true, comments: true, flagIf: 'Yes' },
        { id: 'info-mot-required', text: 'Is a MOT Required', type: 'yesnona', required: true, comments: true, flagIf: 'Yes' },
      ],
    },
    {
      title: null, // free-standing box at the bottom of the paper form
      questions: [
        { id: 'other-info', text: 'Any other Information', type: 'textarea', required: false },
      ],
    },
  ],

  signature: { text: 'Driver’s signature', required: true },
};
