//! Transactional library storage and portable, single-file SQLite snapshots.
use std::{fs, path::{Path, PathBuf}, time::{Duration, Instant}};
use rusqlite::{Connection, OpenFlags, params, config::DbConfig, limits::Limit};
use crate::{Chapter, Folder, LibraryDocument, Video};
const APP_ID: i32 = 0x56434244;
const SCHEMA: i32 = 1;
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const SQL: &str = "
CREATE TABLE folders(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,parent_id TEXT REFERENCES folders(id) DEFERRABLE INITIALLY DEFERRED,created_at INTEGER NOT NULL,position INTEGER NOT NULL);
CREATE TABLE videos(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,folder_id TEXT REFERENCES folders(id) DEFERRABLE INITIALLY DEFERRED,added_at INTEGER NOT NULL,modified_at INTEGER,position INTEGER NOT NULL);
CREATE TABLE chapters(video_id TEXT NOT NULL REFERENCES videos(id),id TEXT NOT NULL,name TEXT NOT NULL,start REAL NOT NULL,end REAL NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(video_id,id));
CREATE TABLE settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);";
fn error(e: impl std::fmt::Display) -> String { format!("Library database: {e}") }
fn configure(db: &mut Connection) -> Result<(), String> {
    db.busy_timeout(Duration::from_secs(5)).map_err(error)?;
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true).map_err(error)?;
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false).map_err(error)?;
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false).map_err(error)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA mmap_size=0;").map_err(error)?;
    db.set_limit(Limit::SQLITE_LIMIT_LENGTH, 1024 * 1024).map_err(error)?;
    db.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0).map_err(error)?;
    db.set_limit(Limit::SQLITE_LIMIT_COLUMN, 64).map_err(error)?;
    // Bound work on malformed or unexpectedly complex backup files.
    let started = Instant::now();
    db.progress_handler(1000, Some(move || started.elapsed() > Duration::from_secs(10))).map_err(error)?;
    Ok(())
}
pub fn path(dir: &Path) -> PathBuf { dir.join("library.sqlite") }
fn check(db: &Connection) -> Result<(), String> {
    let id: i32 = db.pragma_query_value(None,"application_id",|r|r.get(0)).map_err(error)?;
    let version: i32 = db.pragma_query_value(None,"user_version",|r|r.get(0)).map_err(error)?;
    if id != APP_ID || version != SCHEMA { return Err("This is not a supported VidChapterBuddy library backup.".into()); }
    let integrity: String = db.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(error)?;
    if integrity != "ok" { return Err("The library backup is damaged.".into()); }
    let mut statement = db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").map_err(error)?;
    let objects = statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(error)?.collect::<Result<Vec<_>,_>>().map_err(error)?;
    let expected: Vec<_> = ["chapters","folders","settings","videos"].iter().map(|n|(n.to_string(),"table".to_string())).collect();
    if objects != expected { return Err("The backup contains an unsupported database schema.".into()); }
    let violations: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",[],|r|r.get(0)).map_err(error)?;
    if violations { return Err("The backup contains broken library references.".into()); }
    Ok(())
}
fn rows<T>(db: &Connection, sql: &str, map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>) -> Result<Vec<T>, String> {
    let mut stmt = db.prepare(sql).map_err(error)?;
    let result = stmt.query_map([],map).map_err(error)?.collect::<Result<Vec<_>,_>>().map_err(error)?;
    if result.len() > MAX_ROWS { return Err("This library exceeds the supported record limit.".into()); }
    Ok(result)
}
fn epoch(value:u64)->Result<i64,String>{i64::try_from(value).map_err(error)}
fn timestamp(row:&rusqlite::Row<'_>,column:usize)->rusqlite::Result<u64>{
 let value:i64=row.get(column)?;
 u64::try_from(value).map_err(|e|rusqlite::Error::FromSqlConversionFailure(column,rusqlite::types::Type::Integer,Box::new(e)))
}
fn optional_timestamp(row:&rusqlite::Row<'_>,column:usize)->rusqlite::Result<Option<u64>>{
 let value:Option<i64>=row.get(column)?;
 value.map(|n|u64::try_from(n).map_err(|e|rusqlite::Error::FromSqlConversionFailure(column,rusqlite::types::Type::Integer,Box::new(e)))).transpose()
}
fn read(db: &Connection) -> Result<LibraryDocument, String> {
    check(db)?;
    let folders = rows(db,"SELECT id,name,parent_id,created_at FROM folders ORDER BY position LIMIT 100001",|r|Ok(Folder{id:r.get(0)?,name:r.get(1)?,parent_id:r.get(2)?,created_at:timestamp(r,3)?}))?;
    let mut videos = rows(db,"SELECT id,name,path,folder_id,added_at,modified_at FROM videos ORDER BY position LIMIT 100001",|r|Ok(Video{id:r.get(0)?,name:r.get(1)?,path:r.get(2)?,folder_id:r.get(3)?,added_at:timestamp(r,4)?,modified_at:optional_timestamp(r,5)?,chapters:vec![]}))?;
    let index: std::collections::HashMap<_,_> = videos.iter().enumerate().map(|(i,v)|(v.id.clone(),i)).collect();
    let chapters = rows(db,"SELECT video_id,id,name,start,end FROM chapters ORDER BY video_id,position LIMIT 100001",|r|Ok((r.get::<_,String>(0)?,Chapter{id:r.get(1)?,name:r.get(2)?,start:r.get(3)?,end:r.get(4)?})))?;
    for (video,chapter) in chapters { let i = index.get(&video).ok_or("The backup contains an orphan chapter.")?; videos[*i].chapters.push(chapter); }
    let autoplay: String = db.query_row("SELECT value FROM settings WHERE key='autoplay'",[],|r|r.get(0)).map_err(error)?;
    if autoplay != "true" && autoplay != "false" { return Err("The backup contains an invalid autoplay preference.".into()); }
    let document = LibraryDocument{version:2,videos,folders,autoplay:autoplay=="true"};
    crate::validate_metadata(&document)?;
    Ok(document)
}
fn write_rows(db: &Connection, doc: &LibraryDocument) -> Result<(), String> {
    db.execute_batch("DELETE FROM chapters; DELETE FROM videos; DELETE FROM folders; DELETE FROM settings;").map_err(error)?;
    for (i,f) in doc.folders.iter().enumerate() { db.execute("INSERT INTO folders VALUES(?1,?2,?3,?4,?5)",params![f.id,f.name,f.parent_id,epoch(f.created_at)?,i as i64]).map_err(error)?; }
    for (i,v) in doc.videos.iter().enumerate() {
        db.execute("INSERT INTO videos VALUES(?1,?2,?3,?4,?5,?6,?7)",params![v.id,v.name,v.path,v.folder_id,epoch(v.added_at)?,v.modified_at.map(epoch).transpose()?,i as i64]).map_err(error)?;
        for (j,c) in v.chapters.iter().enumerate() { db.execute("INSERT INTO chapters VALUES(?1,?2,?3,?4,?5,?6)",params![v.id,c.id,c.name,c.start,c.end,j as i64]).map_err(error)?; }
    }
    db.execute("INSERT INTO settings VALUES('autoplay',?1)",[if doc.autoplay {"true"} else {"false"}]).map_err(error)?;
    Ok(())
}
fn open_local(dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(dir).map_err(error)?;
    let file = path(dir);
    let mut db = Connection::open_with_flags(&file,OpenFlags::SQLITE_OPEN_READ_WRITE|OpenFlags::SQLITE_OPEN_CREATE|OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(error)?;
    configure(&mut db)?;
    let tables: i64 = db.query_row("SELECT count(*) FROM sqlite_schema",[],|r|r.get(0)).map_err(error)?;
    let version: i32 = db.pragma_query_value(None,"user_version",|r|r.get(0)).map_err(error)?;
    if tables == 0 && version == 0 {
        crate::legacy::migrate_directory(dir)?;
        let json = dir.join("library.json");
        let doc = if json.is_file() { crate::decode_library(&fs::read(json).map_err(error)?)? } else { LibraryDocument::default() };
        crate::validate_metadata(&doc)?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(error)?;
        tx.execute_batch(SQL).map_err(error)?;
        write_rows(&tx,&doc)?;
        tx.pragma_update(None,"application_id",APP_ID).map_err(error)?;
        tx.pragma_update(None,"user_version",SCHEMA).map_err(error)?;
        tx.commit().map_err(error)?;
    }
    check(&db)?;
    let page_size:i64=db.pragma_query_value(None,"page_size",|r|r.get(0)).map_err(error)?;
    db.pragma_update(None,"max_page_count",(MAX_FILE / page_size as u64) as i64).map_err(error)?;
    Ok(db)
}
pub fn load(dir: &Path) -> Result<LibraryDocument, String> { read(&open_local(dir)?) }
pub fn save(dir: &Path, doc: &LibraryDocument) -> Result<(), String> {
    crate::validate_metadata(doc)?;
    let mut db = open_local(dir)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(error)?;
    write_rows(&tx,doc)?;
    tx.commit().map_err(error)
}
struct Temporary(PathBuf);
impl Drop for Temporary {fn drop(&mut self){let _=fs::remove_file(&self.0);}}
pub fn backup(dir: &Path, destination: &Path) -> Result<(), String> {
    let db = open_local(dir)?;
    let parent = destination.parent().ok_or("Choose a backup location.")?;
    let actual = fs::canonicalize(parent).map_err(error)?.join(destination.file_name().ok_or("Invalid backup filename")?);
    if actual == fs::canonicalize(path(dir)).map_err(error)? { return Err("Choose a different file from the active library database.".into()); }
    let temp = Temporary(parent.join(format!(".vidchapterbuddy-backup-{}.sqlite",uuid::Uuid::new_v4())));
    fs::OpenOptions::new().write(true).create_new(true).open(&temp.0).map_err(error)?;
    {
        let mut output = Connection::open_with_flags(&temp.0,OpenFlags::SQLITE_OPEN_READ_WRITE|OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(error)?;
        let backup = rusqlite::backup::Backup::new(&db,&mut output).map_err(error)?;
        let started=Instant::now();
        loop {
            match backup.step(128).map_err(error)? {
                rusqlite::backup::StepResult::Done=>break,
                _ if started.elapsed()>Duration::from_secs(10)=>return Err("Backup timed out. Please retry when the library is idle.".into()),
                _=>std::thread::sleep(Duration::from_millis(5)),
            }
        }
    }
    fs::File::open(&temp.0).map_err(error)?.sync_all().map_err(error)?;
    fs::rename(&temp.0,destination).map_err(error)
}
pub fn read_backup(source: &Path) -> Result<LibraryDocument, String> {
    let meta=fs::metadata(source).map_err(error)?;
    if !meta.is_file() || meta.len()>MAX_FILE { return Err("Choose a SQLite library backup smaller than 64 MiB.".into()); }
    let mut db=Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX|OpenFlags::SQLITE_OPEN_PRIVATE_CACHE).map_err(error)?;
    configure(&mut db)?;
    read(&db)
}
pub fn restore(dir: &Path, document: &LibraryDocument) -> Result<PathBuf, String> {
    crate::validate_metadata(document)?;
    let previous=dir.join(format!("library-before-restore-{}.sqlite",uuid::Uuid::new_v4()));
    backup(dir,&previous)?;
    save(dir,document)?;
    Ok(previous)
}

#[cfg(test)]
mod tests {
 use super::*;
 struct TestDir(PathBuf);
 impl TestDir {fn new()->Self{let p=std::env::temp_dir().join(format!("vidchapterbuddy-sqlite-test-{}",uuid::Uuid::new_v4()));fs::create_dir(&p).unwrap();Self(p)}}
 impl Drop for TestDir{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
 fn fixture()->LibraryDocument{
  LibraryDocument{version:2,autoplay:true,
   folders:vec![Folder{id:"child".into(),name:"Clips".into(),parent_id:Some("parent".into()),created_at:123},Folder{id:"parent".into(),name:"Collection".into(),parent_id:None,created_at:100}],
   videos:vec![Video{id:"v".into(),name:"A title '); DROP TABLE videos; --".into(),path:"/unavailable/clip.wmv".into(),folder_id:Some("child".into()),added_at:321,modified_at:Some(456),chapters:vec![Chapter{id:"c".into(),name:"Introduction".into(),start:1.25,end:30.75}]}]}
 }
 fn assert_equal(a:&LibraryDocument,b:&LibraryDocument){assert_eq!(serde_json::to_value(a).unwrap(),serde_json::to_value(b).unwrap());}
 #[test]
 fn sqlite_round_trip_preserves_order_names_times_and_settings(){
  let dir=TestDir::new();let original=fixture();save(&dir.0,&original).unwrap();assert_equal(&load(&dir.0).unwrap(),&original);
  assert_eq!(&fs::read(path(&dir.0)).unwrap()[..16],b"SQLite format 3\0");
  assert!(!dir.0.join("library.sqlite-wal").exists());
 }
 #[test]
 fn json_migration_runs_once_and_keeps_original(){
  let dir=TestDir::new();let mut original=fixture();original.autoplay=false;
  let bytes=serde_json::to_vec(&original).unwrap();fs::write(dir.0.join("library.json"),&bytes).unwrap();
  assert_equal(&load(&dir.0).unwrap(),&original);
  assert_eq!(fs::read(dir.0.join("library.json")).unwrap(),bytes);
  fs::write(dir.0.join("library.json"),b"invalid old JSON").unwrap();
  assert_equal(&load(&dir.0).unwrap(),&original);
 }
 #[test]
 fn failed_write_rolls_back_every_table(){
  let dir=TestDir::new();let original=fixture();save(&dir.0,&original).unwrap();
  let mut invalid=original.clone();invalid.folders[1].created_at=u64::MAX;
  assert!(save(&dir.0,&invalid).is_err());assert_equal(&load(&dir.0).unwrap(),&original);
 }
 #[test]
 fn portable_backup_restore_and_safety_snapshot(){
  let source=TestDir::new();let destination=TestDir::new();let original=fixture();save(&source.0,&original).unwrap();
  let portable=destination.0.join("portable.sqlite");backup(&source.0,&portable).unwrap();
  assert_equal(&read_backup(&portable).unwrap(),&original);
  // A portable snapshot must work after its source database is gone.
  fs::remove_file(path(&source.0)).unwrap();assert_equal(&read_backup(&portable).unwrap(),&original);
  let old=LibraryDocument::default();save(&destination.0,&old).unwrap();
  let safety=restore(&destination.0,&read_backup(&portable).unwrap()).unwrap();
  assert_equal(&load(&destination.0).unwrap(),&original);assert_equal(&read_backup(&safety).unwrap(),&old);
  assert!(backup(&destination.0,&path(&destination.0)).is_err());
 }
 #[test]
 fn invalid_or_unrelated_backups_leave_library_intact(){
  let dir=TestDir::new();let original=fixture();save(&dir.0,&original).unwrap();
  let junk=dir.0.join("junk.sqlite");fs::write(&junk,b"not a database").unwrap();assert!(read_backup(&junk).is_err());
  let unrelated=dir.0.join("other.sqlite");Connection::open(&unrelated).unwrap().execute_batch("CREATE TABLE unrelated(value TEXT)").unwrap();assert!(read_backup(&unrelated).is_err());
  let oversized=dir.0.join("oversized.sqlite");fs::File::create(&oversized).unwrap().set_len(MAX_FILE+1).unwrap();assert!(read_backup(&oversized).is_err());
  assert_equal(&load(&dir.0).unwrap(),&original);
 }
 #[test]
 fn unexpected_schemas_and_invalid_preferences_are_rejected(){
  let dir=TestDir::new();save(&dir.0,&fixture()).unwrap();let snapshot=dir.0.join("backup.sqlite");backup(&dir.0,&snapshot).unwrap();
  let db=Connection::open(&snapshot).unwrap();db.execute_batch("CREATE VIEW surprise AS SELECT * FROM videos").unwrap();drop(db);assert!(read_backup(&snapshot).is_err());
  fs::remove_file(&snapshot).unwrap();backup(&dir.0,&snapshot).unwrap();
  let db=Connection::open(&snapshot).unwrap();db.execute("UPDATE settings SET value='invalid' WHERE key='autoplay'",[]).unwrap();drop(db);assert!(read_backup(&snapshot).is_err());
 }
}
