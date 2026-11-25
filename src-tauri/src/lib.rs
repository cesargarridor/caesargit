pub mod error;
pub mod git;
pub mod security;
pub mod updater;
pub mod watcher;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            git::commands::open_repo,
            git::commands::get_status,
            git::commands::get_graph,
            git::commands::search_commits,
            git::commands::list_branches,
            git::commands::list_tags,
            git::commands::list_stashes,
            git::commands::checkout,
            git::commands::create_branch,
            git::commands::rename_branch,
            git::commands::delete_branch,
            git::commands::delete_remote_branch,
            git::commands::checkout_remote_branch,
            git::commands::merge_branch,
            git::commands::rebase_onto,
            git::commands::create_tag,
            git::commands::delete_tag,
            git::commands::push_tag,
            git::commands::fetch,
            git::commands::pull,
            git::commands::push,
            git::commands::stash_push,
            git::commands::stash_apply,
            git::commands::stash_pop,
            git::commands::stash_drop,
            git::commands::stash_branch,
            git::commands::stage_paths,
            git::commands::unstage_paths,
            git::commands::stage_all,
            git::commands::unstage_all,
            git::commands::discard_paths,
            git::commands::discard_all,
            git::commands::ignore_path,
            git::commands::get_file_diff,
            git::commands::get_commit_files,
            git::commands::get_commit_file_diff,
            git::commands::get_commit_detail,
            git::commands::apply_hunk,
            git::commands::apply_lines,
            git::commands::commit,
            git::commands::last_commit_message,
            git::commands::undo_last_commit,
            git::commands::cherry_pick,
            git::commands::revert_commit,
            git::commands::reset_to,
            git::commands::is_ancestor_of_head,
            git::commands::rebase_interactive,
            git::commands::list_rebase_commits,
            git::commands::op_continue,
            git::commands::op_abort,
            git::commands::get_conflict,
            git::commands::resolve_conflict,
            git::commands::blame_file,
            git::commands::file_history,
            git::commands::watch_repo,
            git::commands::unwatch_repo,
            updater::app_version,
            updater::check_update,
            updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar CaesarGit");
}
