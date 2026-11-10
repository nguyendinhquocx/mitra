import { Migration } from '@mikro-orm/migrations'

export class Migration20261110190000_Sharing extends Migration {
	override up() {
		this.addSql('create table `share_capability` (`id` text not null primary key, `owner_id` text not null, `hash` text not null, `target_source_id` text not null, `role` text check (`role` in (\'view\', \'edit\')) not null, `overlays` json null, `revoked_at` datetime null, `created_at` datetime not null, constraint `share_capability_owner_id_foreign` foreign key (`owner_id`) references `user` (`id`) on delete cascade, constraint `share_capability_target_source_id_foreign` foreign key (`target_source_id`) references `source` (`id`) on delete cascade);')
		this.addSql('create unique index `share_capability_hash_unique` on `share_capability` (`hash`);')
		this.addSql('create index `share_capability_owner_id_index` on `share_capability` (`owner_id`);')
		this.addSql('create index `share_capability_target_source_id_index` on `share_capability` (`target_source_id`);')
		this.addSql('create table `share_operation` (`id` text not null primary key, `capability_id` text not null, `result` json null, `created_at` datetime not null, constraint `share_operation_capability_id_foreign` foreign key (`capability_id`) references `share_capability` (`id`) on delete cascade);')
		this.addSql('create index `share_operation_created_at_index` on `share_operation` (`created_at`);')
	}

	override down() {
		this.addSql('drop table if exists `share_operation`;')
		this.addSql('drop table if exists `share_capability`;')
	}
}
