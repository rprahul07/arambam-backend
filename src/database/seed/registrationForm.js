/**
 * The member registration form's wording, in both languages.
 *
 * This is "MEMBER REGISTRATION FORM / உறுப்பினர் பதிவு படிவம்" v0.2 as the
 * organisation supplied it. Every Tamil string here is theirs, carried across
 * from the document rather than translated by us — a form is a legal-ish
 * record, and a member signs a declaration at the bottom of it, so the wording
 * they agree to has to be the wording that was approved.
 *
 * Only the *text* lives here. Which fields exist, which are required and what
 * a valid Aadhaar number looks like are decided in code, because those are
 * rules rather than wording, and an administrator changing a label should
 * never be able to change what the form will accept.
 *
 * This is the default. Once an administrator saves an edit, the row in
 * `settings` wins and this file is only ever consulted again for keys the
 * saved copy is missing — which is what makes adding a field here safe.
 */

/** Shorthand: a string in both languages. */
const t = (en, ta) => ({ en, ta });

export const REGISTRATION_FORM = {
  title: t('Member registration form', 'உறுப்பினர் பதிவு படிவம்'),
  intro: t(
    'The same form as the printed one. Fill it in once — renewing later will not ask again.',
    'அச்சிடப்பட்ட படிவத்தின் அதே கேள்விகள். ஒரு முறை நிரப்பினால் போதும் — புதுப்பிக்கும்போது மீண்டும் கேட்கப்படாது.',
  ),

  sections: {
    identity: t('Registration', 'பதிவு'),
    personal: t('Personal Information', 'தனிப்பட்ட விவரங்கள்'),
    contact: t('Contact', 'தொடர்பு விவரங்கள்'),
    guardian: t('Registration for member below 18', '18 வயதிற்குட்பட்டவருக்கான பதிவு'),
    proof: t('PAN number', 'பான் எண்'),
    medical: t('Medical Information', 'மருத்துவ தகவல்கள்'),
    declaration: t('Declaration', 'உறுதிமொழி'),
    /* Shown only when joining: the form and the sign-in details are one act. */
    account: t('Your sign-in details', 'உள்நுழைவு விவரங்கள்'),
  },

  fields: {
    date: {
      label: t('Date', 'தேதி'),
      hint: t('Filled in for you on the day you submit this.', 'நீங்கள் சமர்ப்பிக்கும் நாளில் தானாக நிரப்பப்படும்.'),
    },
    memberId: {
      label: t('Member ID No.', 'உறுப்பினர் அடையாள எண்'),
      hint: t('Issued by Aarambam — you do not fill this in.', 'ஆரம்பம் வழங்குகிறது — இதை நீங்கள் நிரப்ப வேண்டாம்.'),
    },
    photo: {
      label: t('Photograph', 'புகைப்படம்'),
      hint: t('Used on your membership card.', 'உங்கள் உறுப்பினர் அட்டையில் பயன்படுத்தப்படும்.'),
    },
    email: {
      label: t('Email address', 'மின்னஞ்சல் முகவரி'),
      hint: t('Your tickets and receipts are sent here.', 'உங்கள் நுழைவுச்சீட்டுகளும் ரசீதுகளும் இங்கே அனுப்பப்படும்.'),
    },
    password: {
      label: t('Password', 'கடவுச்சொல்'),
      hint: t('', ''),
    },
    passwordConfirm: {
      label: t('Confirm password', 'கடவுச்சொல்லை உறுதிப்படுத்தவும்'),
      hint: t('', ''),
    },
    fullName: {
      label: t('1. Name', 'பெயர்'),
      hint: t('As it appears on your identity document.', 'உங்கள் அடையாள ஆவணத்தில் உள்ளபடி.'),
    },
    age: {
      label: t('2. Age', 'வயது'),
      hint: t('', ''),
    },
    gender: {
      label: t('3. Gender', 'பாலினம்'),
      hint: t('', ''),
    },
    address: {
      label: t('4. Address', 'முகவரி'),
      hint: t('Door number, street, area, town and PIN code.', 'கதவு எண், தெரு, பகுதி, ஊர் மற்றும் அஞ்சல் குறியீடு.'),
    },
    phone: {
      label: t('5. Phone Number', 'தொலைபேசி எண்'),
      hint: t('', ''),
    },
    whatsappNumber: {
      label: t("What's App Number", 'வாட்ஸ்அப் எண்'),
      hint: t('', ''),
    },
    whatsappGroupConsent: {
      label: t(
        '8. Do you give us permission to add your number to our WA group',
        'உங்கள் தொலைபேசி எண் எங்கள் வாட்ஸ்அப் குழுவில் சேர்க்கப்படும்.',
      ),
      hint: t('', ''),
    },
    guardianName: {
      label: t("6. Parent's / Guardian's name", 'தந்தை / தாய் / பாதுகாவலர் பெயர்'),
      hint: t('', ''),
    },
    guardianRelation: {
      label: t('Relationship', 'உறவுமுறை'),
      hint: t('', ''),
    },
    guardianPhone: {
      label: t("Guardian's phone number", 'பாதுகாவலரின் தொலைபேசி எண்'),
      hint: t('Someone we can reach on the day of an event.', 'நிகழ்ச்சி நாளில் நாங்கள் தொடர்பு கொள்ளக்கூடிய எண்.'),
    },
    panNumber: {
      label: t('7. PAN number', 'பான் எண்'),
      hint: t('Optional — leave it blank if you would rather not.', 'விருப்பத்தேர்வு — விரும்பவில்லை என்றால் காலியாக விடவும்.'),
    },
    hasMedicalConditions: {
      label: t(
        '9. Any Allergies or Medical Conditions',
        'ஏதேனும் ஒவ்வாமை அல்லது உடல்நலக் குறைபாடுகள் உள்ளனவா?',
      ),
      hint: t('', ''),
    },
    medicalNotes: {
      label: t('Please tell us what to be aware of', 'என்ன கவனிக்க வேண்டும் என்பதை எங்களுக்குத் தெரிவிக்கவும்'),
      hint: t(
        'Only an organiser running an event you have booked will see this.',
        'நீங்கள் பதிவு செய்த நிகழ்ச்சியை நடத்தும் ஒருங்கிணைப்பாளர் மட்டுமே இதைப் பார்ப்பார்.',
      ),
    },
    mediaConsent: {
      label: t(
        'I am happy to appear in photographs and video',
        'நான் புகைப்படங்களில் இடம்பெற சம்மதிக்கிறேன்',
      ),
      hint: t('', ''),
    },
    declarationAccepted: {
      label: t('I confirm the above', 'மேற்கண்டவற்றை உறுதிப்படுத்துகிறேன்'),
      hint: t('', ''),
    },
    signature: {
      label: t('Signature', 'உறுப்பினர் கையொப்பம்'),
      hint: t(
        'Ticking the box above stands in for the signature on the paper form.',
        'மேலே உள்ள பெட்டியில் குறியிடுவது, அச்சு படிவத்தில் இடும் கையொப்பத்திற்கு சமமானது.',
      ),
    },
  },

  /**
   * The choices a member picks between. The `value` of each is what the
   * database stores and is not editable here — renaming "Male" is wording,
   * renaming `male` would break every record already saved.
   */
  choices: {
    gender: [
      { value: 'male', label: t('Male', 'ஆண்') },
      { value: 'female', label: t('Female', 'பெண்') },
      { value: 'other', label: t('Other', 'பிற') },
    ],
    guardianRelation: [
      { value: 'father', label: t('Father', 'தந்தை') },
      { value: 'mother', label: t('Mother', 'தாய்') },
      { value: 'guardian', label: t('Guardian', 'பாதுகாவலர்') },
    ],
    yesNo: [
      { value: 'yes', label: t('Yes', 'ஆம்') },
      { value: 'no', label: t('No', 'இல்லை') },
    ],
  },

  /** The two paragraphs a member is agreeing to, verbatim from the document. */
  notices: {
    photoConsent: t(
      'Photos and videos taken during our events may be shared on our social media platforms. If you have any concerns or do not wish to appear in these photos or videos, kindly let us know.',
      'எங்கள் நிகழ்ச்சிகளின் போது எடுக்கப்படும் புகைப்படங்கள் மற்றும் காணொளிகள் எங்கள் சமூக ஊடக தளங்களில் பகிரப்படலாம். இதில் நீங்கள் இடம்பெற விரும்பவில்லை அல்லது உங்களுக்கு ஏதேனும் தயக்கம் அல்லது எதிர்ப்பு இருந்தால், தயவுசெய்து எங்களுக்குத் தெரிவிக்கவும்.',
    ),
    declaration: t(
      'I hereby declare that the information provided above is true and correct to the best of my knowledge.',
      'மேலே வழங்கியுள்ள தகவல்கள் என் அறிவிற்கு எட்டிய வரையில் உண்மையானவை மற்றும் சரியானவை என்பதை உறுதிப்படுத்துகிறேன்.',
    ),
  },
};

export default REGISTRATION_FORM;
