const mongoose = require('mongoose');

// ── User Model ───────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  name:      { type: String, default: '' },
  isAdmin:   { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },

  // ── Telegram Integration ──────────────────────────────────────────────────
  telegram: {
    chatId:      { type: String, default: '' },       // Telegram chat ID (set when user links via bot)
    username:    { type: String, default: '' },       // Telegram @username
    linkedAt:    { type: Date },                      // When they linked their account
    linkToken:   { type: String, default: '' },       // One-time token for linking (user sends this to bot)
    linkExpires: { type: Date },                      // Token expiry
  },

  // ── Notification Preferences ──────────────────────────────────────────────
  notifications: {
    telegram:       { type: Boolean, default: true },   // Enable Telegram notifications
    email:          { type: Boolean, default: true },   // Enable email notifications
    dailyReport:    { type: Boolean, default: true },   // Daily job hunt summary
    instantAlerts:  { type: Boolean, default: true },   // Instant alert for 80%+ match jobs
    weeklyDigest:   { type: Boolean, default: false },  // Weekly summary
    applicationReminders: { type: Boolean, default: true }, // Remind if no update on applied jobs
    minScoreAlert:  { type: Number, default: 80 },      // Only alert for jobs above this score
  },
});

// ── Job Model ─────────────────────────────────────────────────────────────────
const jobSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:       { type: String, required: true },
  company:     { type: String, required: true },
  location:    { type: String, default: 'Remote/India' },
  skills:      [String],
  experience:  { type: String },
  salary:      { type: String },
  applyLink:   { type: String, required: true },
  source:      { type: String, enum: ['LinkedIn', 'Naukri', 'Instahyre', 'Wellfound', 'Internshala', 'Remotive', 'Arbeitnow', 'Himalayas', 'Jobicy', 'RemoteOK', 'TheMuse', 'Other'] },
  description: { type: String },
  matchScore:  { type: Number, default: 0 },
  status:      { type: String, enum: ['found', 'applied', 'manual_apply', 'rejected', 'interview'], default: 'found' },
  appliedAt:   { type: Date },
  foundAt:     { type: Date, default: Date.now },
  isRemote:    { type: Boolean, default: false },
  directApply: { type: Boolean, default: false },
  jobId:       { type: String },
});
jobSchema.index({ jobId: 1, userId: 1 }, { unique: true });

// ── Resume Model ──────────────────────────────────────────────────────────────
const resumeSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  rawText:        { type: String },
  skills:         [String],
  experience:     { type: Number },
  roles:          [String],
  education:      { type: String },
  name:           { type: String },
  email:          { type: String },
  updatedAt:      { type: Date, default: Date.now },
});

// ── Application Log ───────────────────────────────────────────────────────────
const applicationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  jobId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
  company:   { type: String, required: true },
  title:     { type: String, required: true },
  location:  String,
  source:    String,
  applyLink: String,
  matchScore: Number,
  status:    { type: String, enum: ['applied', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'], default: 'applied' },
  appliedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  interviewDate: { type: Date },
  coverLetter: String,
  notes:     String,
  nextStep:  String,
});

// ── Daily Report ──────────────────────────────────────────────────────────────
const reportSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date:         { type: Date, default: Date.now },
  jobsFound:    { type: Number, default: 0 },
  highMatch:    { type: Number, default: 0 },
  applied:      { type: Number, default: 0 },
  manualApply:  { type: Number, default: 0 },
  topJobs:      [{ title: String, company: String, score: Number, link: String }],
});

module.exports = {
  User:        mongoose.model('User', userSchema),
  Job:         mongoose.model('Job', jobSchema),
  Resume:      mongoose.model('Resume', resumeSchema),
  Application: mongoose.model('Application', applicationSchema),
  Report:      mongoose.model('Report', reportSchema),
};
