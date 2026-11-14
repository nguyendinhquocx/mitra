import { Migration } from '@mikro-orm/migrations'

export class Migration20261113150000_ShareFileGrant extends Migration {
	override up() {
		this.addSql('create table `share_file_grant` (`id` text not null, `capability_id` text not null, `entry_file_id` text not null, primary key (`id`), constraint `share_file_grant_capability_id_foreign` foreign key (`capability_id`) references `share_capability` (`id`) on update cascade on delete cascade, constraint `share_file_grant_entry_file_id_foreign` foreign key (`entry_file_id`) references `entry_file` (`id`) on update cascade on delete cascade, constraint `share_file_grant_capability_entry_file_unique` unique (`capability_id`, `entry_file_id`));')
	}

	override down() {
		this.addSql('drop table `share_file_grant`;')
	}
}
