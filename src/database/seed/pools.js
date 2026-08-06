/*
 * Ported verbatim from the front end (`src/data/pools.ts`).
 *
 * The demonstration dataset is part of the product, not scaffolding: the
 * event copy, the plan benefits and the category colours are all content the
 * client reviews. Keeping one copy of it — the front end’s — and seeding the
 * database from that is what makes the connected application look exactly
 * like the prototype it replaces.
 */

/**
 * Curated content pools for the demonstration dataset.
 *
 * The supplied member registration form is bilingual English/Tamil, so the
 * placeholder community is set in and around Chennai with Tamil names and
 * real neighbourhood venues. Every value here is intended to be replaced by
 * the client's own data at migration.
 */

export const MALE_FIRST_NAMES = [
  'Arun', 'Karthik', 'Vignesh', 'Senthil', 'Bharath', 'Muthu', 'Sathish',
  'Ramesh', 'Ashwin', 'Dinesh', 'Prabhu', 'Sundar', 'Manikandan', 'Naveen',
  'Gokul', 'Hari', 'Jeeva', 'Vasanth', 'Surya', 'Rajesh', 'Aravind', 'Sakthi',
  'Deepak', 'Anand', 'Vetri', 'Kalidas', 'Ilango', 'Nandha',
];

export const FEMALE_FIRST_NAMES = [
  'Kavitha', 'Priya', 'Anitha', 'Revathi', 'Janaki', 'Divya', 'Nandhini',
  'Yamuna', 'Lakshmi', 'Meena', 'Thamarai', 'Bhuvana', 'Suganya', 'Vaishnavi',
  'Keerthana', 'Malathi', 'Sowmya', 'Ranjani', 'Abirami', 'Hemalatha',
  'Kalaivani', 'Nithya', 'Saranya', 'Vidhya', 'Poongodi', 'Aishwarya',
];

export const SURNAMES = [
  'Sundaram', 'Prakash', 'Raman', 'Kumar', 'Subramanian', 'Selvam', 'Rajan',
  'Narayanan', 'Krishnan', 'Nathan', 'Bharathi', 'Chandran', 'Murugan',
  'Balaji', 'Venkatesan', 'Shanmugam', 'Arumugam', 'Natarajan', 'Ganesan',
  'Palani', 'Ravichandran', 'Thirumalai', 'Elango', 'Manoharan',
];

/** Chennai localities used for member addresses. */
export const LOCALITIES = [
  { area: 'Anna Nagar', city: 'Chennai', district: 'Chennai', pincode: '600040' },
  { area: 'T. Nagar', city: 'Chennai', district: 'Chennai', pincode: '600017' },
  { area: 'Mylapore', city: 'Chennai', district: 'Chennai', pincode: '600004' },
  { area: 'Adyar', city: 'Chennai', district: 'Chennai', pincode: '600020' },
  { area: 'Velachery', city: 'Chennai', district: 'Chennai', pincode: '600042' },
  { area: 'Tambaram', city: 'Chennai', district: 'Chengalpattu', pincode: '600045' },
  { area: 'Porur', city: 'Chennai', district: 'Chennai', pincode: '600116' },
  { area: 'Nungambakkam', city: 'Chennai', district: 'Chennai', pincode: '600034' },
  { area: 'Besant Nagar', city: 'Chennai', district: 'Chennai', pincode: '600090' },
  { area: 'Ambattur', city: 'Chennai', district: 'Tiruvallur', pincode: '600053' },
  { area: 'Perambur', city: 'Chennai', district: 'Chennai', pincode: '600011' },
  { area: 'Guindy', city: 'Chennai', district: 'Chennai', pincode: '600032' },
  { area: 'Kodambakkam', city: 'Chennai', district: 'Chennai', pincode: '600024' },
  { area: 'Chromepet', city: 'Chennai', district: 'Chengalpattu', pincode: '600044' },
  { area: 'Thiruvanmiyur', city: 'Chennai', district: 'Chennai', pincode: '600041' },
];

export const STREET_NAMES = [
  'Bharathi Salai', 'Gandhi Street', 'Kamarajar Street', 'Thiruvalluvar Nagar',
  'Lake View Road', 'Sannathi Street', 'Perumal Koil Street', 'Nehru Street',
  'Vivekananda Road', 'Sastri Nagar 3rd Cross', 'Kalaignar Street',
  'Periyar Nagar 2nd Main', 'Anna Salai Extension', 'Ponnusamy Street',
];

export const EMAIL_DOMAINS = ['gmail.com', 'outlook.com', 'yahoo.in', 'zohomail.in'];

/** Venues used by events. */
export const VENUES = {
  communityHall: {
    venueName: 'Aarambam Community Hall',
    venueAddress: '18, Sastri Nagar 3rd Cross, Anna Nagar West',
    city: 'Chennai',
  },
  vaniMahal: {
    venueName: 'Vani Mahal',
    venueAddress: '103, G N Chetty Road, T. Nagar',
    city: 'Chennai',
  },
  elliots: {
    venueName: "Elliot's Beach",
    venueAddress: 'Beach Road, Besant Nagar',
    city: 'Chennai',
  },
  ymca: {
    venueName: 'YMCA Grounds',
    venueAddress: 'Western Boulevard Road, Nandanam',
    city: 'Chennai',
  },
  mylaporeFineArts: {
    venueName: 'Mylapore Fine Arts Club',
    venueAddress: 'Musiri Subramaniam Road, Mylapore',
    city: 'Chennai',
  },
  semmozhiPoonga: {
    venueName: 'Semmozhi Poonga',
    venueAddress: 'Cathedral Road, Teynampet',
    city: 'Chennai',
  },
  learningCentre: {
    venueName: 'Aarambam Learning Centre',
    venueAddress: '2nd Floor, 44 Lake View Road, West Mambalam',
    city: 'Chennai',
  },
  indoorStadium: {
    venueName: 'Jawaharlal Nehru Indoor Stadium',
    venueAddress: 'Sydenhams Road, Periamet',
    city: 'Chennai',
  },
  georgeTown: {
    venueName: 'George Town Heritage Quarter',
    venueAddress: 'Assembly point: Parry’s Corner Clock Tower',
    city: 'Chennai',
  },
  villageSchool: {
    venueName: 'Panchayat Union Middle School, Kattupakkam',
    venueAddress: 'Kattupakkam Main Road, Kattupakkam',
    city: 'Chengalpattu',
  },
};
