
create table ap_object_types (
	id int IDENTITY primary key clustered not null,
	name nvarchar(100) not null
)

insert into ap_object_types values ('star')
insert into ap_object_types values ('star cluster')
insert into ap_object_types values ('emission nebula')
insert into ap_object_types values ('reflection nebula')
insert into ap_object_types values ('galaxy')

create table ap_object (
	id int IDENTITY primary key clustered not null,
	name nvarchar(1000) not null,
	type int not null,
	position_json nvarchar(1000) not null,
	aliases nvarchar(1000) not null,
	comment nvarchar(1000),
	active bit not null,
	constraint fk_11 foreign key (type) references ap_object_types(id)
)

create table ap_session (
	id int IDENTITY primary key clustered not null,
	name nvarchar(1000) not null,
	start datetime not null,
	duration datetime,
	duration_set bit not null,
	comment nvarchar(1000)
)

create table ap_filter (
	id int IDENTITY primary key clustered not null,
	name nvarchar(100),
	aliases nvarchar(100) ,
)

insert into ap_filter values ('Luminance', 'L;Lum')
insert into ap_filter values ('Red', 'R')
insert into ap_filter values ('Green', 'G')
insert into ap_filter values ('Blue', 'B')
insert into ap_filter values ('H-alpha', 'H;Ha')
insert into ap_filter values ('Oxygen', 'O;Oiii;OIII')
insert into ap_filter values ('Sulphur', 'S;Sii;Siii')

create table ap_exposure (
	id int IDENTITY primary key clustered not null,
	duration int not null,
)

insert into ap_exposure values ('30')
insert into ap_exposure values ('60')
insert into ap_exposure values ('120')
insert into ap_exposure values ('180')
insert into ap_exposure values ('240')
insert into ap_exposure values ('300')
insert into ap_exposure values ('600')

create table ap_object_session (
	id int IDENTITY primary key clustered not null,
	object int not null,
	session int not null,
	frames int not null,
	exposure int not null,
	filter int not null,
	constraint fk_21 foreign key (object) references ap_object(id),
	constraint fk_22 foreign key (session) references ap_session(id),
	constraint fk_23 foreign key (filter) references ap_filter(id),
	constraint fk_24 foreign key (exposure) references ap_exposure(id),
)

create table ap_settings (
	id int IDENTITY primary key clustered not null,
	name nvarchar(100) not null,
	value nvarchar(1000) not null,
)

insert into ap_settings values('file_pattern', 'Light_{target}_*_{duration}.0s_Bin1_{filter}_{short_datetime}_{filenumber}.fit')

create table ap_imported (
	id int IDENTITY primary key clustered not null,
	filename nvarchar(100) not null,
)
create table ap_plan (
	id int IDENTITY primary key clustered not null,
	name nvarchar(100) not null,
	active bit not null,
	object int not null,
	constraint fk_31 foreign key (object) references ap_object(id),
)

create table ap_plan_details (
	id int IDENTITY primary key clustered not null,
	planid int not null,
	duration int not null,
	filter int not null,
	constraint fk_32 foreign key (filter) references ap_filter(id),
)

create table ap_plan_session (
	id int IDENTITY primary key clustered not null,
	planid int not null,
	session int not null,
	constraint fk_41 foreign key (planid) references ap_plan(id),
	constraint fk_42 foreign key (session) references ap_object_session(id),
)	

